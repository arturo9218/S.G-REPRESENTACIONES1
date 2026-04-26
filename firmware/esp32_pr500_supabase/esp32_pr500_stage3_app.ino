/**
 * ESP32 PR500 - STAGE 3 (WiFiManager estable + Ingest)
 *
 * Base:
 * - Portal WiFiManager estable (probado en esp32_wifi_manager_test.ino).
 * - Control local de relés (activo-bajo), con armado F01 para evitar arranques indebidos.
 *
 * Agrega:
 * - Envío periódico a Supabase ingest-reading.
 * - Portal con campos para module_id / api_key / anon_key / api_url persistidos en LittleFS.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <LittleFS.h>

extern "C" {
#include "lwip/ip_addr.h"
#include "lwip/dns.h"
}

// ====== WiFi / FS ======
static const char *AP_NAME = "PR500-Setup";
static const int PIN_FORCE_PORTAL = 14;
static const char *CFG_PATH = "/config.json";
static const char *PARAMS_PATH = "/pr500_params.json";
static const char *DEFAULT_INGEST_URL =
    "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";

static constexpr float PSI_PER_BAR = 14.5037738f;

// ====== Pins ======
static const int PIN_ADC = 36;
static const int PIN_R1 = 25;
static const int PIN_R2 = 26;
static const int PIN_R3 = 32;
static const int REL_PINS[3] = {PIN_R1, PIN_R2, PIN_R3};

// Módulo relé activo-bajo (LOW=ON)
static constexpr bool RELAY_ACTIVE_HIGH = false;
static inline int relayOnLevel() { return RELAY_ACTIVE_HIGH ? HIGH : LOW; }
static inline int relayOffLevel() { return RELAY_ACTIVE_HIGH ? LOW : HIGH; }
static inline bool relayIsOn(int pin) { return digitalRead(pin) == relayOnLevel(); }
static inline void relayWrite(int pin, bool on) { digitalWrite(pin, on ? relayOnLevel() : relayOffLevel()); }

struct Cfg {
  /** POST a ingest-reading; debe ser https y terminar en .../ingest-reading */
  char apiUrl[200]{};
  char moduleId[48]{};
  char apiKey[24]{};
  char anonKey[400]{};
  uint32_t intervalMs = 15000;
  /** Intervalo para traer params desde la app (Supabase fetch-pr500-params). */
  uint32_t paramsPullMs = 60000;
};

struct Params {
  int F01 = 0;         // armado: 0 off total, >=1 habilitado
  float F02 = 2.0f;    // setpoint (bar si F15=0, psi si F15!=0)
  float F03 = 0.5f;    // diferencial (misma unidad que F15)
  float F04 = 0.4f;    // diferencial etapas (misma unidad que F15)
  int F05 = 30;        // gap arranques s
  int F06 = 120;       // min off s
  int F07 = 180;       // min on s
  int F09 = 3;         // compresores 1..3
  float F14 = 0.0f;    // offset (misma unidad que F15)
  int F15 = 0;         // 0=bar, 1=psi (umbrales F02–F04 y F14 en esa unidad; telemetría sigue en bar)
  /** Manual por relé físico C1–C3: >=0.5 fuerza ON (solo si F01 armado, igual firmware PR500 completo). */
  float F17 = 0.f;
  float F18 = 0.f;
  float F19 = 0.f;
};

static Cfg g_cfg;
static Params P;
static WiFiManager wm;
static bool g_fsOk = false;
static unsigned long g_lastRetryMs = 0;
static unsigned long g_lastSendMs = 0;
static unsigned long g_lastTxErrLogMs = 0;
static unsigned long g_lastParamsPullMs = 0;
static unsigned long g_lastPullErrLogMs = 0;
static unsigned long g_lastStartMs = 0;
static bool g_stageWant[3] = {false, false, false};
static unsigned long g_onSince[3] = {0, 0, 0};
static unsigned long g_offSince[3] = {0, 0, 0};
static bool g_portalSaveRequested = false;
static WiFiManagerParameter p_module("module_id", "Module ID", "", 47);
static WiFiManagerParameter p_token("api_key", "Device Token", "", 23);
static WiFiManagerParameter p_anon("anon_key", "Supabase Anon Key", "", 399);
static WiFiManagerParameter p_url("api_url", "Ingest URL", "", 199);

static const char *DEFAULT_PARAMS_JSON =
    "{\"F01\":0,\"F02\":2.0,\"F03\":0.5,\"F04\":0.4,\"F05\":30,\"F06\":120,\"F07\":180,\"F09\":3,\"F14\":0,\"F15\":0,"
    "\"F17\":0,\"F18\":0,\"F19\":0}";

static void trimAsciiInPlace(char *s) {
  if (!s) return;
  size_t n = strlen(s), i = 0;
  while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
  size_t j = n;
  while (j > i && (s[j - 1] == ' ' || s[j - 1] == '\t' || s[j - 1] == '\r' || s[j - 1] == '\n')) j--;
  if (i > 0 || j < n) {
    size_t k = 0;
    for (size_t p = i; p < j; p++) s[k++] = s[p];
    s[k] = 0;
  }
}

static bool ensureFs() {
  if (g_fsOk) return true;
  if (LittleFS.begin(false)) {
    g_fsOk = true;
    return true;
  }
  if (!LittleFS.format()) return false;
  if (!LittleFS.begin(false)) return false;
  g_fsOk = true;
  return true;
}

static bool isValidIngestUrl(const char *u) {
  if (!u) return false;
  size_t n = strlen(u);
  if (n < 40 || n >= sizeof(g_cfg.apiUrl)) return false;
  if (strncmp(u, "https://", 8) != 0) return false;
  return strstr(u, "ingest-reading") != nullptr;
}

static void loadDefaults() {
  memset(&g_cfg, 0, sizeof(g_cfg));
  strlcpy(g_cfg.apiUrl, DEFAULT_INGEST_URL, sizeof(g_cfg.apiUrl));
  g_cfg.intervalMs = 15000;
  g_cfg.paramsPullMs = 60000;
  StaticJsonDocument<256> d;
  deserializeJson(d, DEFAULT_PARAMS_JSON);
  P.F01 = d["F01"] | 0;
  P.F02 = d["F02"] | 2.0f;
  P.F03 = d["F03"] | 0.5f;
  P.F04 = d["F04"] | 0.4f;
  P.F05 = d["F05"] | 30;
  P.F06 = d["F06"] | 120;
  P.F07 = d["F07"] | 180;
  P.F09 = d["F09"] | 3;
  P.F14 = d["F14"] | 0.0f;
  P.F15 = (int)(d["F15"] | 0);
  if (P.F15 != 0) P.F15 = 1;
  P.F17 = d["F17"] | 0.0f;
  P.F18 = d["F18"] | 0.0f;
  P.F19 = d["F19"] | 0.0f;
}

static bool loadConfig() {
  if (!ensureFs()) return false;
  if (!LittleFS.exists(CFG_PATH)) return false;
  File f = LittleFS.open(CFG_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<2048> doc;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) return false;
  {
    const char *u = doc["api_url"] | "";
    if (isValidIngestUrl(u)) strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
    else if (strlen(u) > 0)
      Serial.println(F("[CFG] api_url en flash inválida; se usa la URL por defecto del sketch."));
  }
  strlcpy(g_cfg.moduleId, doc["module_id"] | "", sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey, doc["api_key"] | "", sizeof(g_cfg.apiKey));
  strlcpy(g_cfg.anonKey, doc["supabase_anon_key"] | "", sizeof(g_cfg.anonKey));
  g_cfg.intervalMs = (uint32_t)(doc["interval_ms"] | 15000);
  if (g_cfg.intervalMs < 5000) g_cfg.intervalMs = 5000;
  g_cfg.paramsPullMs = (uint32_t)(doc["params_pull_ms"] | 60000);
  if (g_cfg.paramsPullMs < 15000) g_cfg.paramsPullMs = 15000;
  trimAsciiInPlace(g_cfg.moduleId);
  trimAsciiInPlace(g_cfg.apiKey);
  trimAsciiInPlace(g_cfg.anonKey);
  trimAsciiInPlace(g_cfg.apiUrl);
  return true;
}

static bool saveConfig() {
  if (!ensureFs()) return false;
  StaticJsonDocument<2048> doc;
  doc["api_url"] = g_cfg.apiUrl;
  doc["module_id"] = g_cfg.moduleId;
  doc["api_key"] = g_cfg.apiKey;
  doc["supabase_anon_key"] = g_cfg.anonKey;
  doc["interval_ms"] = g_cfg.intervalMs;
  doc["params_pull_ms"] = g_cfg.paramsPullMs;
  File f = LittleFS.open(CFG_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  return true;
}

static bool loadParams() {
  if (!ensureFs()) return false;
  if (!LittleFS.exists(PARAMS_PATH)) return false;
  File f = LittleFS.open(PARAMS_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<768> d;
  DeserializationError e = deserializeJson(d, f);
  f.close();
  if (e) return false;
  P.F01 = d["F01"] | P.F01;
  P.F02 = d["F02"] | P.F02;
  P.F03 = d["F03"] | P.F03;
  P.F04 = d["F04"] | P.F04;
  P.F05 = d["F05"] | P.F05;
  P.F06 = d["F06"] | P.F06;
  P.F07 = d["F07"] | P.F07;
  P.F09 = d["F09"] | P.F09;
  P.F14 = d["F14"] | P.F14;
  if (d.containsKey("F15")) {
    P.F15 = (int)d["F15"].as<float>();
    if (P.F15 != 0) P.F15 = 1;
  }
  P.F17 = d["F17"] | P.F17;
  P.F18 = d["F18"] | P.F18;
  P.F19 = d["F19"] | P.F19;
  return true;
}

static bool saveParams() {
  if (!ensureFs()) return false;
  StaticJsonDocument<768> d;
  d["F01"] = P.F01; d["F02"] = P.F02; d["F03"] = P.F03; d["F04"] = P.F04;
  d["F05"] = P.F05; d["F06"] = P.F06; d["F07"] = P.F07; d["F09"] = P.F09; d["F14"] = P.F14;
  d["F15"] = P.F15;
  d["F17"] = P.F17; d["F18"] = P.F18; d["F19"] = P.F19;
  File f = LittleFS.open(PARAMS_PATH, "w");
  if (!f) return false;
  serializeJson(d, f);
  f.close();
  return true;
}

/** Presión del sensor escalada a bar (sin offset F14). */
static float pressureBarSensorOnly() {
  analogSetPinAttenuation(PIN_ADC, ADC_11db);
  uint32_t acc = 0;
  for (int i = 0; i < 12; i++) { acc += analogRead(PIN_ADC); delay(2); }
  float v = ((acc / 12.0f) / 4095.0f) * 3.3f;
  return (v / 3.3f) * 8.0f;
}

/** Presión para `ingest-reading` (siempre bar absoluto). F14 en bar si F15=0; si F15=1, F14 es offset en psi → suma en bar. */
static float pressureBarTelemetry() {
  const float b = pressureBarSensorOnly();
  if (P.F15 == 0) return b + P.F14;
  return b + P.F14 / PSI_PER_BAR;
}

/** Lectura en la misma unidad que F02/F03/F04 (bar o psi). */
static float pressureReadingControlUnit() {
  const float b = pressureBarSensorOnly();
  if (P.F15 == 0) return b + P.F14;
  return b * PSI_PER_BAR + P.F14;
}

/** Al cambiar F15 por serie: convierte F02–F04 y F14 (igual que la app). */
static void convertLocalParamsForF15(int prev, int next) {
  const bool fromPsi = prev != 0;
  const bool toPsi = next != 0;
  if (fromPsi == toPsi) return;
  const float mul = toPsi ? PSI_PER_BAR : 1.f / PSI_PER_BAR;
  P.F02 *= mul;
  P.F03 *= mul;
  P.F04 *= mul;
  P.F14 *= mul;
}

static void updateHyst(float p) {
  int n = P.F09; if (n < 1) n = 1; if (n > 3) n = 3;
  float d = P.F03; if (d < 0.05f) d = 0.05f;
  float ds = P.F04; if (ds < 0) ds = 0;
  for (int i = 0; i < 3; i++) {
    if (i >= n) { g_stageWant[i] = false; continue; }
    float onTh = P.F02 - d * 0.5f - i * ds;
    float offTh = P.F02 + d * 0.5f - i * ds;
    if (g_stageWant[i]) { if (p > offTh) g_stageWant[i] = false; }
    else { if (p < onTh) g_stageWant[i] = true; }
  }
}

static void applyRelays(unsigned long nowMs) {
  if (P.F01 == 0) {
    for (int i = 0; i < 3; i++) {
      if (relayIsOn(REL_PINS[i])) {
        relayWrite(REL_PINS[i], false);
        g_offSince[i] = nowMs; g_onSince[i] = 0;
      }
    }
    return;
  }
  /* F01 armado: automático + manual F17–F19 (>=0.5 fuerza ON del relé C1–C3). */
  bool target[3] = {g_stageWant[0], g_stageWant[1], g_stageWant[2]};
  if (P.F17 >= 0.5f) target[0] = true;
  if (P.F18 >= 0.5f) target[1] = true;
  if (P.F19 >= 0.5f) target[2] = true;

  uint32_t minOff = (uint32_t)max(0, P.F06) * 1000UL;
  uint32_t minOn = (uint32_t)max(0, P.F07) * 1000UL;
  uint32_t gap = (uint32_t)max(0, P.F05) * 1000UL;
  for (int i = 0; i < 3; i++) {
    bool cur = relayIsOn(REL_PINS[i]);
    bool want = target[i];
    if (cur == want) continue;
    if (want) {
      /* Manual F17–F19: encendido inmediato (no esperar F06/F05; el automático sigue respetándolos). */
      const bool manualOn =
          (i == 0 && P.F17 >= 0.5f) || (i == 1 && P.F18 >= 0.5f) || (i == 2 && P.F19 >= 0.5f);
      bool offOk = manualOn || (g_offSince[i] == 0) || (nowMs - g_offSince[i] >= minOff);
      bool gapOk = manualOn || (g_lastStartMs == 0) || (nowMs - g_lastStartMs >= gap);
      if (!offOk || !gapOk) continue;
      relayWrite(REL_PINS[i], true); g_onSince[i] = nowMs; g_lastStartMs = nowMs;
    } else {
      bool onOk = (g_onSince[i] == 0) || (nowMs - g_onSince[i] >= minOn);
      if (!onOk) continue;
      relayWrite(REL_PINS[i], false); g_offSince[i] = nowMs; g_onSince[i] = 0;
    }
  }
}

static void setupRelaysSafe() {
  digitalWrite(PIN_R1, relayOffLevel()); digitalWrite(PIN_R2, relayOffLevel()); digitalWrite(PIN_R3, relayOffLevel());
  pinMode(PIN_R1, OUTPUT); pinMode(PIN_R2, OUTPUT); pinMode(PIN_R3, OUTPUT);
  relayWrite(PIN_R1, false); relayWrite(PIN_R2, false); relayWrite(PIN_R3, false);
}

static void runConfigPortalStable() {
  // Modo estable: solo AP/STA para portal (sin BLE).
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(280);
  wm.startConfigPortal(AP_NAME);
}

static void copyPortalConfigAndSave() {
  strlcpy(g_cfg.moduleId, p_module.getValue(), sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey, p_token.getValue(), sizeof(g_cfg.apiKey));
  strlcpy(g_cfg.anonKey, p_anon.getValue(), sizeof(g_cfg.anonKey));
  const char *u = p_url.getValue();
  trimAsciiInPlace(g_cfg.moduleId);
  trimAsciiInPlace(g_cfg.apiKey);
  trimAsciiInPlace(g_cfg.anonKey);
  if (isValidIngestUrl(u)) strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  trimAsciiInPlace(g_cfg.apiUrl);
  if (saveConfig()) {
    Serial.println(F("[CFG] Guardado en LittleFS (token+wifi/config)."));
  } else {
    Serial.println(F("[CFG] Error guardando config.json"));
  }
}

static void flushPortalSaveIfNeeded() {
  if (!g_portalSaveRequested) return;
  copyPortalConfigAndSave();
  g_portalSaveRequested = false;
}

/** Hotspots / routers con DNS roto → TCP a Supabase “connection refused”. Forzar DNS públicos en lwIP. */
static void applyPublicDnsIfStaUp() {
  if (WiFi.status() != WL_CONNECTED) return;
  ip_addr_t d1, d2;
  IP_ADDR4(&d1, 1, 1, 1, 1);
  IP_ADDR4(&d2, 8, 8, 8, 8);
  dns_setserver(0, &d1);
  dns_setserver(1, &d2);
  Serial.println(F("[NET] DNS lwIP → 1.1.1.1 / 8.8.8.8"));
}

static void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.persistent(false);
  wm.setConfigPortalTimeout(0);
  wm.setConnectTimeout(15);
  wm.setMinimumSignalQuality(8);
  wm.setSaveConfigCallback([]() { g_portalSaveRequested = true; });
  p_module.setValue(g_cfg.moduleId, sizeof(g_cfg.moduleId) - 1);
  p_token.setValue(g_cfg.apiKey, sizeof(g_cfg.apiKey) - 1);
  p_anon.setValue(g_cfg.anonKey, sizeof(g_cfg.anonKey) - 1);
  p_url.setValue(g_cfg.apiUrl, sizeof(g_cfg.apiUrl) - 1);
  wm.addParameter(&p_module);
  wm.addParameter(&p_token);
  wm.addParameter(&p_anon);
  wm.addParameter(&p_url);
  bool forcePortal = digitalRead(PIN_FORCE_PORTAL) == LOW;
  if (forcePortal) {
    runConfigPortalStable();
  } else if (!wm.autoConnect(AP_NAME)) {
    runConfigPortalStable();
  }
  flushPortalSaveIfNeeded();
  applyPublicDnsIfStaUp();
  Serial.printf("[WiFi] SSID=%s IP=%s RSSI=%d\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
}

static void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (g_lastRetryMs != 0 && (now - g_lastRetryMs < 10000UL)) return;
  g_lastRetryMs = now;
  if (!WiFi.SSID().length()) return;
  WiFi.reconnect();
}

static bool parseHttpsHost(const char *url, char *hostOut, size_t hostOutSz) {
  if (!url || !hostOut || hostOutSz < 4) return false;
  const char *p = strstr(url, "https://");
  if (p != url) return false;
  p += 8;
  size_t i = 0;
  while (p[i] && p[i] != '/' && p[i] != ':' && i + 1 < hostOutSz) {
    hostOut[i] = p[i];
    i++;
  }
  hostOut[i] = 0;
  return i > 2;
}

static void printNetDiag() {
  Serial.println(F("[NET] ---- diagnóstico (443) ----"));
  Serial.printf("[NET] WiFi.status=%d SSID=%s IP=%s GW=%s DNS=%s RSSI=%d\n", (int)WiFi.status(),
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(),
                WiFi.dnsIP(0).toString().c_str(), (int)WiFi.RSSI());
  Serial.printf("[NET] api_url=%s\n", g_cfg.apiUrl);

  char host[96]{};
  if (!parseHttpsHost(g_cfg.apiUrl, host, sizeof(host))) {
    Serial.println(F("[NET] URL no es https://... válida (revisá copiar/pegar)."));
    return;
  }
  IPAddress ip;
  if (!WiFi.hostByName(host, ip)) {
    Serial.printf("[NET] DNS falló para host=%s (probar otro WiFi o DNS 1.1.1.1 en el router)\n", host);
    return;
  }
  Serial.printf("[NET] DNS %s -> %s\n", host, ip.toString().c_str());

  WiFiClientSecure c;
  c.setInsecure();
  c.setTimeout(12000);
  if (!c.connect(host, 443)) {
    Serial.printf("[NET] TCP 443 rechazado o timeout host=%s (firewall/router o URL de otro proyecto)\n", host);
    return;
  }
  Serial.println(F("[NET] TCP 443 OK — si [TX] sigue fallando, revisá anon_key o body del POST."));
  c.stop();
}

static void sendIngest() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!strlen(g_cfg.moduleId) || !strlen(g_cfg.apiKey)) return;
  if (!isValidIngestUrl(g_cfg.apiUrl)) {
    unsigned long now = millis();
    if (g_lastTxErrLogMs == 0 || (now - g_lastTxErrLogMs > 30000UL)) {
      g_lastTxErrLogMs = now;
      Serial.println(F("[TX] api_url inválida; comando serie: url https://TU_REF.supabase.co/functions/v1/ingest-reading"));
    }
    return;
  }
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(25000);
  HTTPClient http;
  http.setTimeout(25000);
  if (!http.begin(client, g_cfg.apiUrl)) return;
  http.addHeader("Content-Type", "application/json");
  if (strlen(g_cfg.anonKey) > 10) {
    http.addHeader("apikey", g_cfg.anonKey);
    http.addHeader("Authorization", String("Bearer ") + g_cfg.anonKey);
  }
  StaticJsonDocument<512> d;
  d["moduleId"] = g_cfg.moduleId;
  d["deviceToken"] = g_cfg.apiKey;
  d["pressure_bar"] = pressureBarTelemetry();
  d["r1_on"] = relayIsOn(PIN_R1);
  d["r2_on"] = relayIsOn(PIN_R2);
  d["r3_on"] = relayIsOn(PIN_R3);
  d["r4_alarm"] = false;
  String body;
  serializeJson(d, body);
  int code = http.POST(body);
  if (code < 0) {
    delay(200);
    code = http.POST(body);
  }
  if (code < 0) {
    applyPublicDnsIfStaUp();
    delay(400);
    http.end();
    if (http.begin(client, g_cfg.apiUrl)) {
      http.addHeader("Content-Type", "application/json");
      if (strlen(g_cfg.anonKey) > 10) {
        http.addHeader("apikey", g_cfg.anonKey);
        http.addHeader("Authorization", String("Bearer ") + g_cfg.anonKey);
      }
      code = http.POST(body);
    }
  }
  unsigned long now = millis();
  if (code >= 0) {
    Serial.printf("[TX] HTTP %d\n", code);
    if (code >= 400) {
      String resp = http.getString();
      if (resp.length() > 220) resp = resp.substring(0, 220) + "...";
      Serial.printf("[TX] body=%s\n", resp.c_str());
    }
    g_lastTxErrLogMs = 0;
  } else {
    if (g_lastTxErrLogMs == 0 || (now - g_lastTxErrLogMs > 20000UL)) {
      g_lastTxErrLogMs = now;
      Serial.printf("[TX] HTTP %d err=%s url=%s\n", code, http.errorToString(code).c_str(), g_cfg.apiUrl);
      Serial.printf("[TX] WiFi.status=%d RSSI=%d | serie: net (diagnostico)\n", (int)WiFi.status(), (int)WiFi.RSSI());
    }
  }
  http.end();
}

static bool buildFetchParamsUrl(char *out, size_t outSz) {
  if (!isValidIngestUrl(g_cfg.apiUrl) || outSz < 48) return false;
  String s(g_cfg.apiUrl);
  const int ix = s.indexOf("ingest-reading");
  if (ix < 0) return false;
  String t = s.substring(0, (unsigned)ix);
  t += "fetch-pr500-params";
  t += s.substring((unsigned)ix + (unsigned)strlen("ingest-reading"));
  if (t.length() >= (int)outSz) return false;
  strlcpy(out, t.c_str(), outSz);
  return true;
}

static bool applyCloudParams(JsonObject src) {
  if (!src) return false;
  bool ch = false;
  auto applyInt = [&](const char *k, int &ref) {
    if (!src.containsKey(k)) return;
    int v = (int)src[k].as<float>();
    if (v != ref) {
      ref = v;
      ch = true;
    }
  };
  auto applyFloat = [&](const char *k, float &ref) {
    if (!src.containsKey(k)) return;
    float v = src[k].as<float>();
    if (v != ref) {
      ref = v;
      ch = true;
    }
  };
  applyInt("F01", P.F01);
  applyFloat("F02", P.F02);
  applyFloat("F03", P.F03);
  applyFloat("F04", P.F04);
  applyInt("F05", P.F05);
  applyInt("F06", P.F06);
  applyInt("F07", P.F07);
  applyInt("F09", P.F09);
  applyFloat("F14", P.F14);
  if (src.containsKey("F15")) {
    int nv = (int)src["F15"].as<float>();
    if (nv != 0) nv = 1;
    if (nv != P.F15) {
      P.F15 = nv;
      ch = true;
    }
  }
  applyFloat("F17", P.F17);
  applyFloat("F18", P.F18);
  applyFloat("F19", P.F19);
  if (P.F09 < 1) P.F09 = 1;
  if (P.F09 > 3) P.F09 = 3;
  return ch;
}

static void tryPullParamsFromCloud() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!strlen(g_cfg.moduleId) || !strlen(g_cfg.apiKey)) return;
  char url[220]{};
  if (!buildFetchParamsUrl(url, sizeof(url))) return;
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(20000);
  HTTPClient http;
  http.setTimeout(20000);
  if (!http.begin(client, url)) return;
  http.addHeader("Content-Type", "application/json");
  if (strlen(g_cfg.anonKey) > 10) {
    http.addHeader("apikey", g_cfg.anonKey);
    http.addHeader("Authorization", String("Bearer ") + g_cfg.anonKey);
  }
  StaticJsonDocument<256> req;
  req["moduleId"] = g_cfg.moduleId;
  req["deviceToken"] = g_cfg.apiKey;
  String body;
  serializeJson(req, body);
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  unsigned long now = millis();
  if (code != 200) {
    if (g_lastPullErrLogMs == 0 || (now - g_lastPullErrLogMs > 60000UL)) {
      g_lastPullErrLogMs = now;
      Serial.printf("[PULL] HTTP %d (module_id/token deben coincidir con el PR500 en la app)\n", code);
      if (resp.length() > 0 && resp.length() < 240) Serial.printf("[PULL] %s\n", resp.c_str());
    }
    return;
  }
  g_lastPullErrLogMs = 0;
  StaticJsonDocument<3072> doc;
  if (deserializeJson(doc, resp)) return;
  if (!doc["ok"].as<bool>()) return;
  JsonObject p = doc["params"].as<JsonObject>();
  if (applyCloudParams(p)) {
    saveParams();
    Serial.println(F("[PULL] Parámetros actualizados desde la app (Supabase)."));
  }
}

static void printParams() {
  Serial.printf("[PRM] F01=%d F15=%d F02=%.2f F03=%.2f F04=%.2f F05=%d F06=%d F07=%d F09=%d F14=%.3f\n", P.F01, P.F15,
                P.F02, P.F03, P.F04, P.F05, P.F06, P.F07, P.F09, P.F14);
  Serial.printf("[PRM] manual F17=%.2f F18=%.2f F19=%.2f (>=0.5=ON relé C1/C2/C3; en app o serie: set f17 1)\n", P.F17, P.F18, P.F19);
  if (P.F01 < 1 && (P.F17 >= 0.5f || P.F18 >= 0.5f || P.F19 >= 0.5f)) {
    Serial.println(F("[PRM] !! F01=0 (desarmado): F17/F18/F19 no pueden prender relés. Poné F01>=1 en app o: set f01 1"));
  }
}

/** Línea tipo: set f01 1  o  set f02 2.5 */
static void tryHandleSetLine(const String &raw) {
  String low = raw;
  low.trim();
  low.toLowerCase();
  if (!low.startsWith("set ")) return;
  String rest = low.substring(4);
  rest.trim();
  int sp = rest.indexOf(' ');
  if (sp <= 0) {
    Serial.println(F("Uso: set f01 1 | set f17 1 | set f02 2.5 | ..."));
    return;
  }
  String key = rest.substring(0, sp);
  String valStr = rest.substring(sp + 1);
  valStr.trim();
  float v = valStr.toFloat();
  if (key == "f01") P.F01 = (int)v;
  else if (key == "f02") P.F02 = v;
  else if (key == "f03") P.F03 = v;
  else if (key == "f04") P.F04 = v;
  else if (key == "f05") P.F05 = (int)v;
  else if (key == "f06") P.F06 = (int)v;
  else if (key == "f07") P.F07 = (int)v;
  else if (key == "f09") P.F09 = (int)v;
  else if (key == "f14") P.F14 = v;
  else if (key == "f15") {
    int nv = (v >= 0.5f) ? 1 : 0;
    if (nv != P.F15) convertLocalParamsForF15(P.F15, nv);
    P.F15 = nv;
  } else if (key == "f17") P.F17 = v;
  else if (key == "f18") P.F18 = v;
  else if (key == "f19") P.F19 = v;
  else {
    Serial.println(F("Claves: f01 f02 f03 f04 f05 f06 f07 f09 f14 f15 f17 f18 f19"));
    return;
  }
  if (P.F09 < 1) P.F09 = 1;
  if (P.F09 > 3) P.F09 = 3;
  saveParams();
  Serial.println(F("[PRM] OK guardado en flash."));
  printParams();
}

static void printStatus() {
  Serial.printf("[WiFi] status=%d SSID=%s IP=%s RSSI=%d\n", (int)WiFi.status(),
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  Serial.printf("[PR500] P=%.2f%s telem=%.2fbar ARM=%d SP=%.2f D=%.2f STAGE=%.2f F15=%d comps=%d\n",
                pressureReadingControlUnit(), (P.F15 != 0) ? "psi" : "bar", pressureBarTelemetry(), P.F01, P.F02, P.F03,
                P.F04, P.F15, P.F09);
  Serial.printf("[REL] R1=%d R2=%d R3=%d (activo_%s)\n",
                relayIsOn(PIN_R1) ? 1 : 0, relayIsOn(PIN_R2) ? 1 : 0, relayIsOn(PIN_R3) ? 1 : 0,
                RELAY_ACTIVE_HIGH ? "alto" : "bajo");
  Serial.printf("[CFG] api_url=%s\n", g_cfg.apiUrl);
  Serial.printf("[CFG] module_id=%s api_key_len=%u anon_len=%u interval_ms=%lu pull_ms=%lu\n", g_cfg.moduleId,
                (unsigned)strlen(g_cfg.apiKey), (unsigned)strlen(g_cfg.anonKey), (unsigned long)g_cfg.intervalMs,
                (unsigned long)g_cfg.paramsPullMs);
}

void setup() {
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
  setupRelaysSafe();
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\nESP32 PR500 STAGE3 APP"));
  loadDefaults();
  ensureFs();
  loadConfig();
  loadParams();
  setupWifi();
  g_lastSendMs = millis() - g_cfg.intervalMs;
  g_lastParamsPullMs = millis() - g_cfg.paramsPullMs + 5000UL;
  printStatus();
  Serial.println(
      F("[INIT] App: editá parámetros en Angular → se bajan solos. Serie: p | set f01 1 | pull | pullms 60000"));
  Serial.println(F("[INIT] status | net | url ... | portal | reboot"));
}

void loop() {
  maintainWifi();
  float p = pressureReadingControlUnit();
  updateHyst(p);
  applyRelays(millis());

  unsigned long now = millis();
  if (now - g_lastSendMs >= g_cfg.intervalMs) {
    g_lastSendMs = now;
    sendIngest();
  }
  if (WiFi.status() == WL_CONNECTED && strlen(g_cfg.moduleId) && strlen(g_cfg.apiKey)) {
    if (now - g_lastParamsPullMs >= g_cfg.paramsPullMs) {
      g_lastParamsPullMs = now;
      tryPullParamsFromCloud();
    }
  }

  if (Serial.available()) {
    String raw = Serial.readStringUntil('\n');
    raw.trim();
    if (raw.length() == 0) {
      /* skip */
    } else if (raw.length() >= 4 && raw.substring(0, 4).equalsIgnoreCase("url ")) {
      String u = raw.substring(4);
      u.trim();
      if (isValidIngestUrl(u.c_str())) {
        strlcpy(g_cfg.apiUrl, u.c_str(), sizeof(g_cfg.apiUrl));
        saveConfig();
        Serial.printf("[CFG] api_url guardada OK len=%u\n", (unsigned)strlen(g_cfg.apiUrl));
      } else {
        Serial.println(F("[CFG] URL inválida. Ejemplo:"));
        Serial.println(F("url https://abcdefghijklmnop.supabase.co/functions/v1/ingest-reading"));
      }
    } else {
      String cmd = raw;
      cmd.toLowerCase();
      if (cmd.startsWith("set ")) {
        tryHandleSetLine(raw);
      } else if (cmd == "p") {
        printParams();
      } else if (cmd == "pull") {
        tryPullParamsFromCloud();
      } else if (cmd.startsWith("pullms ")) {
        unsigned long n = (unsigned long)cmd.substring(7).toInt();
        if (n >= 15000UL && n <= 3600000UL) {
          g_cfg.paramsPullMs = (uint32_t)n;
          saveConfig();
          Serial.printf("[CFG] params_pull_ms=%lu\n", (unsigned long)g_cfg.paramsPullMs);
        } else {
          Serial.println(F("pullms entre 15000 y 3600000"));
        }
      } else if (cmd == "status") {
        printStatus();
      } else if (cmd == "net") {
        printNetDiag();
      } else if (cmd == "portal") {
        runConfigPortalStable();
        flushPortalSaveIfNeeded();
        Serial.printf("[WiFi] Portal cerrado. SSID=%s IP=%s\n", WiFi.SSID().c_str(),
                      WiFi.localIP().toString().c_str());
      } else if (cmd == "reboot") {
        ESP.restart();
      } else {
        Serial.println(F("p | set f01 1 | pull | pullms 60000 | status | net | url ... | portal | reboot"));
      }
    }
  }

  delay(60);
}

