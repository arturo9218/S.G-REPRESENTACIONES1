/**
 * AR Monitoreo - Datalogger ESP32 (multi-canal)
 * -----------------------------------------------------------------
 * 6× temperatura NTC, 3× consumo (ADC corriente), 2× presión ADC.
 * Parámetros F01–F34 en app (AR01–AR34), sync nube fetch-datalogger-params.
 * Telemetría POST ingest-reading (kind datalogger).
 *
 * Pines por defecto (AR01–AR11 / F01–F11):
 *   Temp 1..6  -> GPIO 34,35,32,33,36,39
 *   Corriente  -> GPIO 25,26,27
 *   Presión    -> GPIO 14,12
 *   Portal WiFi forzado -> GPIO0 a GND al encender
 *
 * Sensores:
 *   Corriente: SCT-013 — escala AR21–AR23 (10/20/30/50/60 A por 1 V, desde la app)
 *   Presion: 4-20 mA + 150 ohm, 0.5-8 bar (igual PR500)
 *
 * Dependencias: WiFiManager, ArduinoJson v6, core ESP32
 * Serie 115200: help | status | raw | pull | tx | wifi
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <math.h>

// ============== Constantes hardware ======================
#define PIN_FORCE_PORTAL 0

#ifndef NTC_R_SERIES_TO_VCC
#define NTC_R_SERIES_TO_VCC 1
#endif

static constexpr float R_FIXED = 10000.0f;
static constexpr float BETA = 3950.0f;
static constexpr float T0K = 298.15f;
static constexpr float R0 = 10000.0f;
static constexpr uint8_t ADC_SAMPLES = 8;
static constexpr float TEMP_ERR = -127.0f;

// ============== Escalado sensores ==============================================
/** Respaldo si AR21–AR23 aún no llegaron de la nube (solo desarrollo). */
#ifndef SCT_AMPS_PER_VOLT_FALLBACK
#define SCT_AMPS_PER_VOLT_FALLBACK 30
#endif

/** Corriente: 0=SCT (AR21–AR23) | 1=lineal 0-3.3V->0-50A | 2=ACS712-30A */
#ifndef CURRENT_SCALE_MODE
#define CURRENT_SCALE_MODE 0
#endif

/** Presión: 0=PR500 4-20mA 150Ω 0.5-8bar */
#ifndef PRESS_SCALE_MODE
#define PRESS_SCALE_MODE 0
#endif

static constexpr int SCT_SCALE_OPTS[] = {10, 20, 30, 50, 60};

static float normalizeSctAmpsPerVolt(float raw) {
  if (!isfinite(raw) || raw < 8.0f) raw = (float)SCT_AMPS_PER_VOLT_FALLBACK;
  int best = SCT_AMPS_PER_VOLT_FALLBACK;
  float bestDiff = 999.0f;
  for (int o : SCT_SCALE_OPTS) {
    const float d = fabsf(raw - (float)o);
    if (d < bestDiff) {
      bestDiff = d;
      best = o;
    }
  }
  return (float)best;
}

static float sctAmpsPerVoltForChannel(int ch) {
  const float vals[] = {P.F21, P.F22, P.F23};
  if (ch < 0 || ch > 2) return normalizeSctAmpsPerVolt((float)SCT_AMPS_PER_VOLT_FALLBACK);
  return normalizeSctAmpsPerVolt(vals[ch]);
}

/** Igual que PR500 Stage3 (`esp32_pr500_stage3_app.ino`). */
static constexpr float MA_SHUNT_OHMS = 150.0f;
static constexpr float MA_ADC_V_AT_4MA = 0.004f * MA_SHUNT_OHMS;
static constexpr float MA_ADC_V_AT_20MA = 0.020f * MA_SHUNT_OHMS;
static constexpr float MA_PRESS_BAR_MIN = 0.5f;
static constexpr float MA_PRESS_BAR_MAX = 8.0f;

static void currentScaleLabelForChannel(int ch, char *buf, size_t len) {
#if CURRENT_SCALE_MODE == 0
  snprintf(buf, len, "SCT C%d %dA/1V", ch + 1, (int)sctAmpsPerVoltForChannel(ch));
#elif CURRENT_SCALE_MODE == 2
  snprintf(buf, len, "ACS712-30A");
#else
  snprintf(buf, len, "lineal 0-3.3V=0-50A");
#endif
}

static const char *pressScaleLabel() {
#if PRESS_SCALE_MODE == 0
  return "4-20mA 150ohm 0.5-8bar (PR500)";
#elif PRESS_SCALE_MODE == 1
  return "0-3.3V=0-16bar";
#else
  return "4-20mA 150ohm 0-10bar";
#endif
}

static float currentAFromVolts(float v, int ch) {
#if CURRENT_SCALE_MODE == 0
  if (v < 0.02f) return 0.0f;
  float a = v * sctAmpsPerVoltForChannel(ch);
  return a < 0.0f ? 0.0f : a;
#elif CURRENT_SCALE_MODE == 2
  float a = (v - 1.65f) / 0.066f;
  return a < 0.0f ? 0.0f : a;
#else
  float a = (v / 3.3f) * 50.0f;
  return a < 0.0f ? 0.0f : a;
#endif
}

static float pressBarFromVolts(float v) {
#if PRESS_SCALE_MODE == 0
  const float spanV = MA_ADC_V_AT_20MA - MA_ADC_V_AT_4MA;
  float bar = MA_PRESS_BAR_MIN;
  if (spanV > 0.001f) {
    bar = MA_PRESS_BAR_MIN + (v - MA_ADC_V_AT_4MA) / spanV * (MA_PRESS_BAR_MAX - MA_PRESS_BAR_MIN);
  }
  if (bar < MA_PRESS_BAR_MIN) bar = MA_PRESS_BAR_MIN;
  if (bar > MA_PRESS_BAR_MAX) bar = MA_PRESS_BAR_MAX;
  return bar;
#elif PRESS_SCALE_MODE == 1
  float bar = (v / 3.3f) * 16.0f;
  return bar < 0.0f ? 0.0f : bar;
#else
  const float vMin = 0.6f;
  const float vMax = 3.0f;
  if (v <= vMin) return 0.0f;
  if (v >= vMax) return 10.0f;
  return (v - vMin) / (vMax - vMin) * 10.0f;
#endif
}

static constexpr const char *CFG_PATH = "/config.json";
static constexpr const char *PARAMS_PATH = "/datalogger.json";
static constexpr const char *AP_NAME = "Datalogger-Setup";
static constexpr unsigned long PORTAL_TIMEOUT_SEC = 5UL * 60UL;
static constexpr unsigned long WIFI_BOOT_CONNECT_MS = 20000UL;
static constexpr unsigned long PARAMS_PULL_MS = 60UL * 1000UL;
static constexpr unsigned long MIN_TX_INTERVAL_MS = 10000UL;

struct Cfg {
  char apiUrl[200] = "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";
  char moduleId[64] = "";
  char apiKey[48] = "";
  uint32_t intervalMs = 60000UL;
} g_cfg;

/** Defaults = app datalogger-params.defaults.ts */
struct DataloggerParams {
  float F01 = 34;
  float F02 = 35;
  float F03 = 32;
  float F04 = 33;
  float F05 = 36;
  float F06 = 39;
  float F07 = 25;
  float F08 = 26;
  float F09 = 27;
  float F10 = 14;
  float F11 = 12;
  float F12 = 60;
  float F13 = 1;
  float F14 = 220;
  float F15 = -30;
  float F16 = 15;
  float F17 = -30;
  float F18 = 15;
  float F19 = 0;
  float F20 = 0;
  float F21 = 30;
  float F22 = 30;
  float F23 = 30;
  float F24 = 1;
  float F25 = 1;
  float F26 = 0;
  float F27 = 0;
  float F28 = 0;
  float F29 = 0;
  float F30 = 1;
  float F31 = 0;
  float F32 = 0;
  float F33 = 1;
  float F34 = 0;
} P;

static void enforceFixedPins() {
  P.F01 = 34;
  P.F02 = 35;
  P.F03 = 32;
  P.F04 = 33;
  P.F05 = 36;
  P.F06 = 39;
  P.F07 = 25;
  P.F08 = 26;
  P.F09 = 27;
  P.F10 = 14;
  P.F11 = 12;
}

static bool channelEnabled(float f) {
  return isfinite(f) && f >= 0.5f;
}

static float normalizeOnOff(float f) {
  return channelEnabled(f) ? 1.0f : 0.0f;
}

struct ChannelReadings {
  float temp[6];
  bool tempOk[6];
  float currentA[3];
  bool currentOk[3];
  float powerW[3];
  float pressBar[2];
  bool pressOk[2];
} g_read;

static WiFiManager wm;
static bool g_portalSaveRequested = false;
static bool g_portalRunning = false;
static bool g_pullNowRequested = false;
static String g_paramsUpdatedAt = "";
static unsigned long g_lastTelMs = 0;
static unsigned long g_lastPullMs = 0;
static unsigned long g_lastReadMs = 0;

static WiFiManagerParameter p_module("module_id", "Module ID (alta Datalogger)", "", 47);
static WiFiManagerParameter p_token("api_key", "Device Token (6 digitos)", "", 47);
static WiFiManagerParameter p_url(
  "api_url", "Ingest URL",
  "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading", 180);

static int clampPin(float f) {
  if (!isfinite(f) || f <= 0.5f) return -1;
  const int p = (int)lroundf(f);
  if (p < 1 || p > 39) return -1;
  return p;
}

static bool ensureFs() {
  if (!LittleFS.begin(true)) {
    Serial.println(F("[FS] LittleFS fail"));
    return false;
  }
  return true;
}

static bool loadConfig() {
  if (!ensureFs() || !LittleFS.exists(CFG_PATH)) return false;
  File f = LittleFS.open(CFG_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, f)) {
    f.close();
    return false;
  }
  f.close();
  const char *u = doc["api_url"] | "";
  if (strncmp(u, "https://", 8) == 0 && strstr(u, "/functions/v1/")) {
    strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  }
  strlcpy(g_cfg.moduleId, doc["module_id"] | "", sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey, doc["api_key"] | "", sizeof(g_cfg.apiKey));
  g_cfg.intervalMs = doc["interval_ms"] | g_cfg.intervalMs;
  return true;
}

static bool saveConfig() {
  if (!ensureFs()) return false;
  StaticJsonDocument<512> doc;
  doc["api_url"] = g_cfg.apiUrl;
  doc["module_id"] = g_cfg.moduleId;
  doc["api_key"] = g_cfg.apiKey;
  doc["interval_ms"] = g_cfg.intervalMs;
  File f = LittleFS.open(CFG_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  return true;
}

static void applyParamsFromJson(JsonObject obj) {
#define ASSIGN(K)                     \
  do {                                \
    auto v = obj[#K];                 \
    if (!v.isNull()) P.K = v.as<float>(); \
  } while (0)
  ASSIGN(F01);
  ASSIGN(F02);
  ASSIGN(F03);
  ASSIGN(F04);
  ASSIGN(F05);
  ASSIGN(F06);
  ASSIGN(F07);
  ASSIGN(F08);
  ASSIGN(F09);
  ASSIGN(F10);
  ASSIGN(F11);
  ASSIGN(F12);
  ASSIGN(F13);
  ASSIGN(F14);
  ASSIGN(F15);
  ASSIGN(F16);
  ASSIGN(F17);
  ASSIGN(F18);
  ASSIGN(F19);
  ASSIGN(F20);
  ASSIGN(F21);
  ASSIGN(F22);
  ASSIGN(F23);
  ASSIGN(F24);
  ASSIGN(F25);
  ASSIGN(F26);
  ASSIGN(F27);
  ASSIGN(F28);
  ASSIGN(F29);
  ASSIGN(F30);
  ASSIGN(F31);
  ASSIGN(F32);
  ASSIGN(F33);
  ASSIGN(F34);
#undef ASSIGN
  enforceFixedPins();
  P.F21 = normalizeSctAmpsPerVolt(P.F21);
  P.F22 = normalizeSctAmpsPerVolt(P.F22);
  P.F23 = normalizeSctAmpsPerVolt(P.F23);
  P.F24 = normalizeOnOff(P.F24);
  P.F25 = normalizeOnOff(P.F25);
  P.F26 = normalizeOnOff(P.F26);
  P.F27 = normalizeOnOff(P.F27);
  P.F28 = normalizeOnOff(P.F28);
  P.F29 = normalizeOnOff(P.F29);
  P.F30 = normalizeOnOff(P.F30);
  P.F31 = normalizeOnOff(P.F31);
  P.F32 = normalizeOnOff(P.F32);
  P.F33 = normalizeOnOff(P.F33);
  P.F34 = normalizeOnOff(P.F34);
}

static void syncTelemetryInterval() {
  unsigned long ms = (unsigned long)(P.F12 * 1000.0f);
  if (ms < MIN_TX_INTERVAL_MS) ms = MIN_TX_INTERVAL_MS;
  g_cfg.intervalMs = ms;
}

static void loadParams() {
  if (!ensureFs() || !LittleFS.exists(PARAMS_PATH)) return;
  File f = LittleFS.open(PARAMS_PATH, "r");
  if (!f) return;
  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, f) != DeserializationError::Ok) {
    f.close();
    return;
  }
  f.close();
  if (doc.containsKey("updated_at")) {
    g_paramsUpdatedAt = String((const char *)(doc["updated_at"] | ""));
  }
  JsonObject obj = doc.containsKey("params") ? doc["params"].as<JsonObject>() : doc.as<JsonObject>();
  applyParamsFromJson(obj);
  syncTelemetryInterval();
}

static bool saveParams(JsonObject src) {
  if (!ensureFs()) return false;
  StaticJsonDocument<2048> doc;
  doc["updated_at"] = g_paramsUpdatedAt;
  JsonObject p = doc.createNestedObject("params");
  for (JsonPair kv : src) p[kv.key()] = kv.value();
  File f = LittleFS.open(PARAMS_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  return true;
}

static void copyPortalAndSave() {
  strlcpy(g_cfg.moduleId, p_module.getValue(), sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey, p_token.getValue(), sizeof(g_cfg.apiKey));
  const char *u = p_url.getValue();
  if (strncmp(u, "https://", 8) == 0 && strstr(u, "/functions/v1/")) {
    strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  }
  saveConfig();
  Serial.println(F("[CFG] Guardado desde portal"));
}

static bool connectSavedWifi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin();
  const unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(250);
    yield();
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] OK %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  return false;
}

static void runConfigPortal() {
  g_portalRunning = true;
  g_portalSaveRequested = false;
  wm.stopConfigPortal();
  WiFi.persistent(true);
  WiFi.disconnect(true, false);
  delay(200);
  WiFi.mode(WIFI_AP_STA);
  wm.setBreakAfterConfig(true);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_SEC);
  wm.setConfigPortalBlocking(true);
  Serial.println(F("[WiFi] Portal Datalogger-Setup 192.168.4.1"));
  wm.startConfigPortal(AP_NAME);
  if (g_portalSaveRequested) copyPortalAndSave();
  wm.stopConfigPortal();
  WiFi.softAPdisconnect(true);
  g_portalRunning = false;
  if (WiFi.status() != WL_CONNECTED) connectSavedWifi(30000UL);
}

static void setupWifi() {
  WiFi.setSleep(false);
  WiFi.persistent(true);
  wm.setSaveConfigCallback([]() { g_portalSaveRequested = true; });
  p_module.setValue(g_cfg.moduleId, sizeof(g_cfg.moduleId) - 1);
  p_token.setValue(g_cfg.apiKey, sizeof(g_cfg.apiKey) - 1);
  p_url.setValue(g_cfg.apiUrl, sizeof(g_cfg.apiUrl) - 1);
  wm.addParameter(&p_module);
  wm.addParameter(&p_token);
  wm.addParameter(&p_url);

  if (digitalRead(PIN_FORCE_PORTAL) == LOW || strlen(g_cfg.moduleId) == 0 || strlen(g_cfg.apiKey) == 0) {
    runConfigPortal();
    return;
  }
  connectSavedWifi(WIFI_BOOT_CONNECT_MS);
}

static String paramsUrl() {
  String u(g_cfg.apiUrl);
  int idx = u.lastIndexOf("/ingest-reading");
  if (idx > 0) {
    u.remove(idx);
    u += "/fetch-datalogger-params";
    return u;
  }
  idx = u.lastIndexOf('/');
  if (idx > 0) {
    u.remove(idx);
    u += "/fetch-datalogger-params";
  }
  return u;
}

static void pullParamsFromCloud() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!g_cfg.moduleId[0] || !g_cfg.apiKey[0]) return;

  const String url = paramsUrl();
  if (url.length() == 0) return;

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(url)) return;
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<200> req;
  req["moduleId"] = g_cfg.moduleId;
  req["deviceToken"] = g_cfg.apiKey;
  String body;
  serializeJson(req, body);

  const int code = http.POST(body);
  const String resp = http.getString();
  http.end();
  if (code != 200) {
    Serial.printf("[PULL] HTTP %d\n", code);
    return;
  }

  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, resp)) return;

  const char *upd = doc["updated_at"] | "";
  if (upd[0] && g_paramsUpdatedAt == upd) return;

  JsonVariant pv = doc["params"];
  JsonObject obj = pv.is<JsonObject>() ? pv.as<JsonObject>() : doc.as<JsonObject>();
  if (obj.isNull() || obj.size() == 0) {
    if (upd[0]) g_paramsUpdatedAt = String(upd);
    return;
  }

  g_paramsUpdatedAt = String(upd);
  applyParamsFromJson(obj);
  syncTelemetryInterval();
  saveParams(obj);
  Serial.printf("[PULL] OK %d claves updated_at=%s\n", (int)obj.size(), upd);
}

static float rNtcFromAdc(int adc) {
#if NTC_R_SERIES_TO_VCC
  return R_FIXED * ((float)adc / (4095.0f - (float)adc));
#else
  return R_FIXED * ((4095.0f - (float)adc) / (float)adc);
#endif
}

static float tempCFromAdc(int adc) {
  const float rNTC = rNtcFromAdc(adc);
  if (rNTC <= 1.0f || rNTC > 500000.0f) return TEMP_ERR;
  const float tK = 1.0f / ((1.0f / T0K) + (1.0f / BETA) * logf(rNTC / R0));
  return tK - 273.15f;
}

static int readAdcAverage(int pin, bool &rawFault) {
  analogSetPinAttenuation(pin, ADC_11db);
  long acc = 0;
  int valid = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    const int v = analogRead(pin);
    if (v > 8 && v < 4088) {
      acc += v;
      valid++;
    }
    delayMicroseconds(250);
  }
  if (valid < ADC_SAMPLES / 2) {
    rawFault = true;
    return -1;
  }
  rawFault = false;
  return (int)(acc / valid);
}

static float adcToVolts(int adc) {
  return ((float)adc / 4095.0f) * 3.3f;
}

static bool tempValid(float t) {
  return isfinite(t) && t > -80.0f && t < 125.0f && t != TEMP_ERR;
}

static void readTemperatures() {
  const float *pins = &P.F01;
  const float *en = &P.F24;
  for (int i = 0; i < 6; i++) {
    g_read.tempOk[i] = false;
    g_read.temp[i] = TEMP_ERR;
    if (!channelEnabled(en[i])) continue;
    const int pin = clampPin(pins[i]);
    if (pin < 0) continue;
    bool rf = false;
    const int adc = readAdcAverage(pin, rf);
    if (adc < 0 || rf) continue;
    const float t = tempCFromAdc(adc);
    if (!tempValid(t)) continue;
    g_read.temp[i] = t;
    g_read.tempOk[i] = true;
  }
}

static void readCurrentsAndPower() {
  const float *pins = &P.F07;
  const float *en = &P.F30;
  const float vLine = (P.F14 > 50.0f && P.F14 < 500.0f) ? P.F14 : 220.0f;
  for (int i = 0; i < 3; i++) {
    g_read.currentOk[i] = false;
    g_read.currentA[i] = 0.0f;
    g_read.powerW[i] = 0.0f;
    if (!channelEnabled(en[i])) continue;
    const int pin = clampPin(pins[i]);
    if (pin < 0) continue;
    bool rf = false;
    const int adc = readAdcAverage(pin, rf);
    if (adc < 0 || rf) continue;
    const float v = adcToVolts(adc);
    const float a = currentAFromVolts(v, i);
    if (!isfinite(a)) continue;
    g_read.currentA[i] = a;
    g_read.powerW[i] = a * vLine;
    g_read.currentOk[i] = true;
  }
}

static void readPressures() {
  const float *pins = &P.F10;
  const float *en = &P.F33;
  for (int i = 0; i < 2; i++) {
    g_read.pressOk[i] = false;
    g_read.pressBar[i] = 0.0f;
    if (!channelEnabled(en[i])) continue;
    const int pin = clampPin(pins[i]);
    if (pin < 0) continue;
    bool rf = false;
    const int adc = readAdcAverage(pin, rf);
    if (adc < 0 || rf) continue;
    const float v = adcToVolts(adc);
    const float bar = pressBarFromVolts(v);
    if (!isfinite(bar)) continue;
    g_read.pressBar[i] = bar;
    g_read.pressOk[i] = true;
  }
}

static void readAllChannels() {
  readTemperatures();
  readCurrentsAndPower();
  readPressures();
}

static void checkAlarms() {
  if (g_read.tempOk[0]) {
    const bool lo = P.F15 > -200.0f && g_read.temp[0] < P.F15;
    const bool hi = P.F16 < 200.0f && g_read.temp[0] > P.F16;
    if (lo) Serial.printf("[ALM] T1 baja %.1f < %.1f C\n", g_read.temp[0], P.F15);
    if (hi) Serial.printf("[ALM] T1 alta %.1f > %.1f C\n", g_read.temp[0], P.F16);
  }
  if (g_read.tempOk[1]) {
    const bool lo = P.F17 > -200.0f && g_read.temp[1] < P.F17;
    const bool hi = P.F18 < 200.0f && g_read.temp[1] > P.F18;
    if (lo) Serial.printf("[ALM] T2 baja %.1f < %.1f C\n", g_read.temp[1], P.F17);
    if (hi) Serial.printf("[ALM] T2 alta %.1f > %.1f C\n", g_read.temp[1], P.F18);
  }
  if (g_read.currentOk[0] && P.F19 > 0.01f && g_read.currentA[0] > P.F19) {
    Serial.printf("[ALM] I1 alta %.2f > %.2f A\n", g_read.currentA[0], P.F19);
  }
  if (g_read.pressOk[0] && P.F20 > 0.01f && g_read.pressBar[0] > P.F20) {
    Serial.printf("[ALM] P1 alta %.2f > %.2f bar\n", g_read.pressBar[0], P.F20);
  }
}

static void printRawAdc() {
  Serial.println(F("---- ADC raw (mV) ----"));
  Serial.printf("Escala presion: %s\n", pressScaleLabel());
  for (int i = 0; i < 3; i++) {
    char scl[24];
    currentScaleLabelForChannel(i, scl, sizeof(scl));
    Serial.printf("  %s\n", scl);
  }
  const float *tp = &P.F01;
  const float *te = &P.F24;
  for (int i = 0; i < 6; i++) {
    const int pin = clampPin(tp[i]);
    if (pin < 0) continue;
    if (!channelEnabled(te[i])) {
      Serial.printf("  T%d GPIO%d off (AR%d=0)\n", i + 1, pin, 24 + i);
      continue;
    }
    bool rf = false;
    const int adc = readAdcAverage(pin, rf);
    Serial.printf("  T%d GPIO%d ADC=%d %.0f mV fault=%d\n", i + 1, pin, adc, adc >= 0 ? adcToVolts(adc) * 1000.0f : 0.0f, rf ? 1 : 0);
  }
  const float *ip = &P.F07;
  const float *ie = &P.F30;
  for (int i = 0; i < 3; i++) {
    const int pin = clampPin(ip[i]);
    if (pin < 0) continue;
    if (!channelEnabled(ie[i])) {
      Serial.printf("  I%d GPIO%d off (AR%d=0)\n", i + 1, pin, 30 + i);
      continue;
    }
    bool rf = false;
    const int adc = readAdcAverage(pin, rf);
    const float v = adc >= 0 ? adcToVolts(adc) : 0.0f;
    Serial.printf("  I%d GPIO%d ADC=%d %.0f mV -> %.2f A\n", i + 1, pin, adc, v * 1000.0f, currentAFromVolts(v, i));
  }
  const float *pp = &P.F10;
  const float *pe = &P.F33;
  for (int i = 0; i < 2; i++) {
    const int pin = clampPin(pp[i]);
    if (pin < 0) continue;
    if (!channelEnabled(pe[i])) {
      Serial.printf("  P%d GPIO%d off (AR%d=0)\n", i + 1, pin, 33 + i);
      continue;
    }
    bool rf = false;
    const int adc = readAdcAverage(pin, rf);
    const float v = adc >= 0 ? adcToVolts(adc) : 0.0f;
    Serial.printf("  P%d GPIO%d ADC=%d %.0f mV -> %.2f bar\n", i + 1, pin, adc, v * 1000.0f, pressBarFromVolts(v));
  }
}

static void printStatus() {
  Serial.println(F("---- Datalogger status ----"));
  Serial.printf("WiFi=%s module=%s cloud=%s interval=%lus\n",
                WiFi.status() == WL_CONNECTED ? "OK" : "OFF",
                g_cfg.moduleId,
                P.F13 >= 0.5f ? "ON" : "OFF",
                g_cfg.intervalMs / 1000UL);
  Serial.printf("Escala presion: %s | linea AR14=%.0f V\n", pressScaleLabel(), P.F14);
  for (int i = 0; i < 3; i++) {
    char scl[24];
    currentScaleLabelForChannel(i, scl, sizeof(scl));
    Serial.printf("  Corriente C%d: %s en=%d (AR%d)\n", i + 1, scl, channelEnabled((&P.F30)[i]) ? 1 : 0, 30 + i);
  }
  for (int i = 0; i < 6; i++) {
    if (g_read.tempOk[i]) Serial.printf("  T%d=%.2f C\n", i + 1, g_read.temp[i]);
  }
  for (int i = 0; i < 3; i++) {
    if (g_read.currentOk[i]) {
      Serial.printf("  I%d=%.2f A  P%d=%.0f W\n", i + 1, g_read.currentA[i], i + 1, g_read.powerW[i]);
    }
  }
  for (int i = 0; i < 2; i++) {
    if (g_read.pressOk[i]) Serial.printf("  Pr%d=%.2f bar\n", i + 1, g_read.pressBar[i]);
  }
  Serial.printf("GPIO fijos | Habilitar AR24-34: T[%d,%d,%d,%d,%d,%d] I[%d,%d,%d] P[%d,%d]\n",
                channelEnabled(P.F24) ? 1 : 0, channelEnabled(P.F25) ? 1 : 0, channelEnabled(P.F26) ? 1 : 0,
                channelEnabled(P.F27) ? 1 : 0, channelEnabled(P.F28) ? 1 : 0, channelEnabled(P.F29) ? 1 : 0,
                channelEnabled(P.F30) ? 1 : 0, channelEnabled(P.F31) ? 1 : 0, channelEnabled(P.F32) ? 1 : 0,
                channelEnabled(P.F33) ? 1 : 0, channelEnabled(P.F34) ? 1 : 0);
}

static void appendRounded(JsonObject doc, const char *key, float v) {
  doc[key] = roundf(v * 100.0f) / 100.0f;
}

static void sendTelemetry() {
  if (P.F13 < 0.5f) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!g_cfg.moduleId[0] || !g_cfg.apiKey[0]) return;

  bool hasAny = false;
  for (int i = 0; i < 6; i++) if (g_read.tempOk[i]) hasAny = true;
  for (int i = 0; i < 3; i++) if (g_read.currentOk[i]) hasAny = true;
  for (int i = 0; i < 2; i++) if (g_read.pressOk[i]) hasAny = true;
  if (!hasAny) {
    Serial.println(F("[TX] omitido: sin canales validos"));
    return;
  }

  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(g_cfg.apiUrl)) return;
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<768> doc;
  doc["moduleId"] = g_cfg.moduleId;
  doc["deviceToken"] = g_cfg.apiKey;

  if (g_read.tempOk[0]) appendRounded(doc, "temp1_c", g_read.temp[0]);
  if (g_read.tempOk[1]) appendRounded(doc, "temp2_c", g_read.temp[1]);
  if (g_read.tempOk[2]) appendRounded(doc, "temp3_c", g_read.temp[2]);
  if (g_read.tempOk[3]) appendRounded(doc, "temp4_c", g_read.temp[3]);
  if (g_read.tempOk[4]) appendRounded(doc, "temp5_c", g_read.temp[4]);
  if (g_read.tempOk[5]) appendRounded(doc, "temp6_c", g_read.temp[5]);

  if (g_read.currentOk[0]) appendRounded(doc, "current1_a", g_read.currentA[0]);
  if (g_read.currentOk[1]) appendRounded(doc, "current2_a", g_read.currentA[1]);
  if (g_read.currentOk[2]) appendRounded(doc, "current3_a", g_read.currentA[2]);

  if (g_read.currentOk[0]) appendRounded(doc, "power1_w", g_read.powerW[0]);
  if (g_read.currentOk[1]) appendRounded(doc, "power2_w", g_read.powerW[1]);
  if (g_read.currentOk[2]) appendRounded(doc, "power3_w", g_read.powerW[2]);

  if (g_read.pressOk[0]) appendRounded(doc, "press1_bar", g_read.pressBar[0]);
  if (g_read.pressOk[1]) appendRounded(doc, "press2_bar", g_read.pressBar[1]);

  if (g_paramsUpdatedAt.length() > 0) doc["params_updated_at"] = g_paramsUpdatedAt;

  String body;
  serializeJson(doc, body);

  const int code = http.POST(body);
  const String resp = http.getString();
  Serial.printf("[TX] POST %d\n", code);
  http.end();
  if (code != 200) {
    Serial.println(resp);
    return;
  }

  StaticJsonDocument<256> rx;
  if (deserializeJson(rx, resp) == DeserializationError::Ok) {
    const char *pu = rx["params_updated_at"] | "";
    if (pu[0] && g_paramsUpdatedAt != pu) g_pullNowRequested = true;
  }
}

static void handleSerial() {
  if (!Serial.available()) return;
  String s = Serial.readStringUntil('\n');
  s.trim();
  s.toLowerCase();
  if (s.length() == 0) return;

  if (s == "help") {
    Serial.println(F("Comandos: help | status | raw | pull | tx | wifi"));
  } else if (s == "status") {
    readAllChannels();
    printStatus();
  } else if (s == "raw") {
    printRawAdc();
  } else if (s == "pull") {
    pullParamsFromCloud();
  } else if (s == "tx") {
    readAllChannels();
    sendTelemetry();
  } else if (s == "wifi") {
    runConfigPortal();
  } else {
    Serial.printf("[SER] desconocido: %s (help)\n", s.c_str());
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
  analogReadResolution(12);

  memset(&g_read, 0, sizeof(g_read));
  Serial.println(F("\n[BOOT] AR Monitoreo Datalogger ESP32"));
  ensureFs();
  loadConfig();
  loadParams();
  syncTelemetryInterval();
  setupWifi();

  if (WiFi.status() == WL_CONNECTED) pullParamsFromCloud();
  readAllChannels();
  printStatus();
  Serial.printf("[BOOT] presion: %s | SCT AR21-23: %.0f %.0f %.0f A/1V\n", pressScaleLabel(), P.F21, P.F22, P.F23);
  Serial.println(F("[BOOT] listo. Comandos: help | status | raw | pull | tx | wifi"));
}

void loop() {
  handleSerial();

  const unsigned long now = millis();

  if (now - g_lastReadMs >= 1000UL) {
    g_lastReadMs = now;
    readAllChannels();
    checkAlarms();
  }

  if (WiFi.status() == WL_CONNECTED && !g_portalRunning) {
    if (now - g_lastTelMs >= g_cfg.intervalMs) {
      g_lastTelMs = now;
      sendTelemetry();
    }
    if (g_pullNowRequested || now - g_lastPullMs >= PARAMS_PULL_MS) {
      g_lastPullMs = now;
      g_pullNowRequested = false;
      pullParamsFromCloud();
    }
  } else if (!g_portalRunning && WiFi.status() != WL_CONNECTED) {
    static unsigned long lastRetry = 0;
    if (lastRetry == 0 || now - lastRetry >= 30000UL) {
      lastRetry = now;
      WiFi.disconnect(false);
      WiFi.begin();
    }
  }

  delay(50);
}
