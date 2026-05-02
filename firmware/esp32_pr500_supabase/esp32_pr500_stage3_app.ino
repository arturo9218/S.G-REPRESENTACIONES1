/**
 * ESP32 PR500 - STAGE 3 (WiFiManager estable + Ingest)
 *
 * Uso previsto: **central frigorífica** — regulación por presión de proceso (p. ej. succión común o punto acordado
 * en instalación). F02/F03/F04/F14/F15 son magnitudes en el punto del sensor; F22 elige histéresis “baja P” o “alta P”.
 *
 * Base:
 * - Portal WiFiManager estable (probado en esp32_wifi_manager_test.ino).
 * - Control local de relés (activo-bajo), con F01 armado (solo 0=desarmado o 1=habilitado).
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
#include <math.h>

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

/** F01: solo 0 (desarmado, todo OFF) o 1 (control habilitado). Cualquier número se interpreta como en la app (≥0.5 → 1). */
static inline int normalizeF01FromFloat(float v) { return (v >= 0.5f) ? 1 : 0; }

/** F02: setpoint en la unidad de F15; rango acotado a la escala del ADC (0…8 bar, ver `pressureBarSensorOnly`). */
static constexpr float F02_BAR_MIN = 0.05f;
static constexpr float F02_BAR_MAX = 8.0f;

static float clampF02(float v, int f15) {
  const float lo = (f15 != 0) ? (F02_BAR_MIN * PSI_PER_BAR) : F02_BAR_MIN;
  const float hi = (f15 != 0) ? (F02_BAR_MAX * PSI_PER_BAR) : F02_BAR_MAX;
  if (v < lo) v = lo;
  else if (v > hi) v = hi;
  return roundf(v * 100.f) / 100.f;
}

/** F03: ancho de banda de histéresis general (misma unidad que F15). Mínimo 0.05 (ver `updateHyst`). */
static constexpr float F03_BAR_MIN = 0.05f;
static constexpr float F03_BAR_MAX = 6.0f;

static float clampF03(float v, int f15) {
  const float lo = (f15 != 0) ? (F03_BAR_MIN * PSI_PER_BAR) : F03_BAR_MIN;
  const float hi = (f15 != 0) ? (F03_BAR_MAX * PSI_PER_BAR) : F03_BAR_MAX;
  if (v < lo) v = lo;
  else if (v > hi) v = hi;
  return roundf(v * 100.f) / 100.f;
}

/** Umbrales tipo F10/F11 con 0 = desactivado (no usar `clampF02` directo: sube el mínimo). */
static float clampF02AllowZero(float v, int f15) {
  if (v <= 0.f) return 0.f;
  return clampF02(v, f15);
}

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
  int F01 = 0;         // armado: 0=desarmado (relés OFF), 1=habilitado
  float F02 = 2.0f;    // setpoint (bar si F15=0, psi si F15!=0); rango F02_BAR_* en esa unidad
  float F03 = 0.5f;    // diferencial general / banda histéresis (misma unidad que F15); rango F03_BAR_*
  float F04 = 0.4f;    // diferencial etapas (misma unidad que F15)
  int F05 = 30;        // gap arranques s
  int F06 = 120;       // min off s
  int F07 = 180;       // min on s
  int F08 = 0;         // rotación lead compresor (h); 0=sin rotación
  int F09 = 3;         // compresores 1..3
  float F10 = 0.f;   // alarma baja P: umbral (misma unidad F15); 0=desactiva
  float F11 = 0.f;   // alarma alta P; 0=desactiva
  int F12 = 60;      // s debajo de F10 para latch alarma baja
  int F13 = 60;      // s encima de F11 para latch alarma alta
  float F14 = 0.0f;    // offset (misma unidad que F15)
  int F15 = 0;         // 0=bar, 1=psi (umbrales F02–F04 y F14 en esa unidad; telemetría sigue en bar)
  int F16 = 0;         // escribir 1 desde app para borrar latch de alarmas (se normaliza a 0)
  int F20 = 3;       // marca de versión lógica (info)
  int F21 = 0;       // reserva OTA (0/1)
  /** Manual por relé físico C1–C3: >=0.5 fuerza ON (solo si F01 armado, igual firmware PR500 completo). */
  float F17 = 0.f;
  float F18 = 0.f;
  float F19 = 0.f;
  /** 0 = histéresis clásica (enciende si P baja del set). 1 = alta presión (enciende si P >= F02+F03−i·F04; apaga si P <= F02−i·F04). */
  int F22 = 0;
  /** 0 = sin detección por tensión ADC. >0 = s con señal inválida antes de alarma sensor + ciclo emergencia (mín. 5). */
  int F23 = 10;
  /** s encendido compresores 1..F09 en emergencia por fallo sensor (10..7200). */
  int F24 = 300;
  /** s apagado en ese ciclo (10..7200). */
  int F25 = 300;
  /** Tensión mínima válida en la entrada ADC (V, 0…3,25). Por debajo → falla (cable a masa / desconectado típ.). */
  float F26 = 0.08f;
  /** Tensión máxima válida (V, 0,05…3,3). Por encima → falla. Debe ser ≥ F26 + 0,05 V. */
  float F27 = 3.22f;
};

static Cfg g_cfg;
static Params P;
static void clampAdcThresholds();
static WiFiManager wm;
static bool g_fsOk = false;
static unsigned long g_lastRetryMs = 0;
static unsigned long g_lastSendMs = 0;
static unsigned long g_lastTxErrLogMs = 0;
static unsigned long g_lastParamsPullMs = 0;
static unsigned long g_lastPullErrLogMs = 0;
static unsigned long g_lastCloudFailMs = 0;
static unsigned long g_lastStartMs = 0;
static bool g_stageWant[3] = {false, false, false};
/** Tiempos anti-ciclado por relé físico C1..C3 (índice 0=R1,1=R2,2=R3). */
static unsigned long g_onSincePhys[3] = {0, 0, 0};
static unsigned long g_offSincePhys[3] = {0, 0, 0};
static bool g_alarmLow = false;
static bool g_alarmHigh = false;
static bool g_alarmSensor = false;
static unsigned long g_lowCondSince = 0;
static unsigned long g_highCondSince = 0;
static unsigned long g_sensorInvalidSince = 0;
static unsigned long g_sensorValidRecoverSince = 0;
/** Ciclo ON/OFF de compresores cuando hay latch de fallo de sensor. */
static bool g_emergOnPhase = true;
static unsigned long g_emergPhaseStartMs = 0;
/** Desfase lógico→físico para rotación (0..2). */
static int g_stageRot = 0;
static unsigned long g_nextRotAtMs = 0;
static bool g_portalSaveRequested = false;
static WiFiManagerParameter p_module("module_id", "Module ID", "", 47);
static WiFiManagerParameter p_token("api_key", "Device Token", "", 23);
static WiFiManagerParameter p_anon("anon_key", "Supabase Anon Key", "", 399);
static WiFiManagerParameter p_url("api_url", "Ingest URL", "", 199);

static const char *DEFAULT_PARAMS_JSON =
    "{\"F01\":0,\"F02\":2.0,\"F03\":0.5,\"F04\":0.4,\"F05\":30,\"F06\":120,\"F07\":180,\"F08\":0,\"F09\":3,"
    "\"F10\":0,\"F11\":0,\"F12\":60,\"F13\":60,\"F14\":0,\"F15\":0,\"F16\":0,\"F17\":0,\"F18\":0,\"F19\":0,\"F20\":3,"
    "\"F21\":0,\"F22\":0,\"F23\":10,\"F24\":300,\"F25\":300,\"F26\":0.08,\"F27\":3.22}";

static constexpr uint32_t CLOUD_CLIENT_TIMEOUT_MS = 6000;
static constexpr uint32_t CLOUD_COOLDOWN_MS = 15000;

/** Evita encadenar bloqueos HTTP cuando Internet está caído pero WiFi sigue "conectado". */
static bool cloudInCooldown(unsigned long nowMs) {
  if (g_lastCloudFailMs == 0) return false;
  return (nowMs - g_lastCloudFailMs) < CLOUD_COOLDOWN_MS;
}

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
  P.F01 = normalizeF01FromFloat(d["F01"].as<float>());
  P.F02 = d["F02"] | 2.0f;
  P.F03 = d["F03"] | 0.5f;
  P.F04 = d["F04"] | 0.4f;
  P.F05 = d["F05"] | 30;
  P.F06 = d["F06"] | 120;
  P.F07 = d["F07"] | 180;
  P.F08 = (int)(d["F08"] | 0);
  P.F09 = d["F09"] | 3;
  P.F10 = d["F10"] | 0.0f;
  P.F11 = d["F11"] | 0.0f;
  P.F12 = (int)(d["F12"] | 60);
  P.F13 = (int)(d["F13"] | 60);
  P.F14 = d["F14"] | 0.0f;
  P.F15 = (int)(d["F15"] | 0);
  if (P.F15 != 0) P.F15 = 1;
  P.F02 = clampF02(P.F02, P.F15);
  P.F03 = clampF03(P.F03, P.F15);
  P.F10 = clampF02AllowZero(P.F10, P.F15);
  P.F11 = clampF02AllowZero(P.F11, P.F15);
  P.F16 = d.containsKey("F16") ? normalizeF01FromFloat(d["F16"].as<float>()) : 0;
  P.F17 = d["F17"] | 0.0f;
  P.F18 = d["F18"] | 0.0f;
  P.F19 = d["F19"] | 0.0f;
  P.F20 = (int)(d["F20"] | 3);
  P.F21 = d.containsKey("F21") ? normalizeF01FromFloat(d["F21"].as<float>()) : 0;
  P.F22 = d.containsKey("F22") ? normalizeF01FromFloat(d["F22"].as<float>()) : 0;
  P.F23 = d.containsKey("F23") ? (int)d["F23"].as<float>() : 10;
  P.F24 = d.containsKey("F24") ? (int)d["F24"].as<float>() : 300;
  P.F25 = d.containsKey("F25") ? (int)d["F25"].as<float>() : 300;
  P.F26 = d.containsKey("F26") ? d["F26"].as<float>() : 0.08f;
  P.F27 = d.containsKey("F27") ? d["F27"].as<float>() : 3.22f;
  if (P.F23 < 0) P.F23 = 0;
  else if (P.F23 > 0 && P.F23 < 5) P.F23 = 5;
  else if (P.F23 > 600) P.F23 = 600;
  if (P.F24 < 10) P.F24 = 10;
  if (P.F24 > 7200) P.F24 = 7200;
  if (P.F25 < 10) P.F25 = 10;
  if (P.F25 > 7200) P.F25 = 7200;
  clampAdcThresholds();
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
  StaticJsonDocument<2048> d;
  DeserializationError e = deserializeJson(d, f);
  f.close();
  if (e) return false;
  if (d.containsKey("F01")) P.F01 = normalizeF01FromFloat(d["F01"].as<float>());
  P.F02 = d["F02"] | P.F02;
  P.F03 = d["F03"] | P.F03;
  P.F04 = d["F04"] | P.F04;
  P.F05 = d["F05"] | P.F05;
  P.F06 = d["F06"] | P.F06;
  P.F07 = d["F07"] | P.F07;
  P.F08 = d["F08"] | P.F08;
  P.F09 = d["F09"] | P.F09;
  P.F10 = d["F10"] | P.F10;
  P.F11 = d["F11"] | P.F11;
  P.F12 = d["F12"] | P.F12;
  P.F13 = d["F13"] | P.F13;
  P.F14 = d["F14"] | P.F14;
  if (d.containsKey("F15")) {
    P.F15 = (int)d["F15"].as<float>();
    if (P.F15 != 0) P.F15 = 1;
  }
  if (d.containsKey("F16")) P.F16 = normalizeF01FromFloat(d["F16"].as<float>());
  P.F17 = d["F17"] | P.F17;
  P.F18 = d["F18"] | P.F18;
  P.F19 = d["F19"] | P.F19;
  P.F20 = d["F20"] | P.F20;
  if (d.containsKey("F21")) P.F21 = normalizeF01FromFloat(d["F21"].as<float>());
  if (d.containsKey("F22")) P.F22 = normalizeF01FromFloat(d["F22"].as<float>());
  if (d.containsKey("F23")) P.F23 = (int)d["F23"].as<float>();
  if (d.containsKey("F24")) P.F24 = (int)d["F24"].as<float>();
  if (d.containsKey("F25")) P.F25 = (int)d["F25"].as<float>();
  if (d.containsKey("F26")) P.F26 = d["F26"].as<float>();
  if (d.containsKey("F27")) P.F27 = d["F27"].as<float>();
  P.F01 = normalizeF01FromFloat((float)P.F01);
  P.F02 = clampF02(P.F02, P.F15);
  P.F03 = clampF03(P.F03, P.F15);
  P.F10 = clampF02AllowZero(P.F10, P.F15);
  P.F11 = clampF02AllowZero(P.F11, P.F15);
  if (P.F12 < 1) P.F12 = 1;
  if (P.F12 > 3600) P.F12 = 3600;
  if (P.F13 < 1) P.F13 = 1;
  if (P.F13 > 3600) P.F13 = 3600;
  if (P.F08 < 0) P.F08 = 0;
  if (P.F08 > 8760) P.F08 = 8760;
  if (P.F20 < 0) P.F20 = 0;
  if (P.F20 > 999) P.F20 = 999;
  P.F16 = normalizeF01FromFloat((float)P.F16);
  P.F21 = normalizeF01FromFloat((float)P.F21);
  P.F22 = normalizeF01FromFloat((float)P.F22);
  if (P.F23 < 0) P.F23 = 0;
  else if (P.F23 > 0 && P.F23 < 5) P.F23 = 5;
  else if (P.F23 > 600) P.F23 = 600;
  if (P.F24 < 10) P.F24 = 10;
  if (P.F24 > 7200) P.F24 = 7200;
  if (P.F25 < 10) P.F25 = 10;
  if (P.F25 > 7200) P.F25 = 7200;
  clampAdcThresholds();
  return true;
}

static bool saveParams() {
  if (!ensureFs()) return false;
  StaticJsonDocument<2048> d;
  d["F01"] = P.F01;
  d["F02"] = P.F02;
  d["F03"] = P.F03;
  d["F04"] = P.F04;
  d["F05"] = P.F05;
  d["F06"] = P.F06;
  d["F07"] = P.F07;
  d["F08"] = P.F08;
  d["F09"] = P.F09;
  d["F10"] = P.F10;
  d["F11"] = P.F11;
  d["F12"] = P.F12;
  d["F13"] = P.F13;
  d["F14"] = P.F14;
  d["F15"] = P.F15;
  d["F16"] = P.F16;
  d["F17"] = P.F17;
  d["F18"] = P.F18;
  d["F19"] = P.F19;
  d["F20"] = P.F20;
  d["F21"] = P.F21;
  d["F22"] = P.F22;
  d["F23"] = P.F23;
  d["F24"] = P.F24;
  d["F25"] = P.F25;
  d["F26"] = P.F26;
  d["F27"] = P.F27;
  File f = LittleFS.open(PARAMS_PATH, "w");
  if (!f) return false;
  serializeJson(d, f);
  f.close();
  return true;
}

/** Muestreo ADC pin 36: tensión 0–3,3 V y presión “cruda” 0–8 bar (sin F14). */
static void samplePressureAdc(float *adcVoltsOut, float *barRawOut) {
  analogSetPinAttenuation(PIN_ADC, ADC_11db);
  uint32_t acc = 0;
  for (int i = 0; i < 12; i++) {
    acc += analogRead(PIN_ADC);
    delay(2);
  }
  const float v = ((acc / 12.0f) / 4095.0f) * 3.3f;
  *adcVoltsOut = v;
  *barRawOut = (v / 3.3f) * 8.0f;
}

/** Acota F26/F27 (V en el pin ADC) y garantiza ventana ≥ 50 mV. */
static void clampAdcThresholds() {
  if (P.F26 < 0.f) P.F26 = 0.f;
  else if (P.F26 > 3.25f) P.F26 = 3.25f;
  if (P.F27 < 0.05f) P.F27 = 0.05f;
  else if (P.F27 > 3.3f) P.F27 = 3.3f;
  if (P.F27 < P.F26 + 0.05f) P.F27 = P.F26 + 0.05f;
  if (P.F27 > 3.3f) P.F27 = 3.3f;
  if (P.F26 > P.F27 - 0.05f) P.F26 = P.F27 - 0.05f;
  if (P.F26 < 0.f) P.F26 = 0.f;
}

/** Tensión dentro de la ventana F26…F27 (parametrizable desde la app). */
static bool adcVoltageValid(float v) { return v >= P.F26 && v <= P.F27; }

/** Presión del sensor escalada a bar (sin offset F14). */
static float pressureBarSensorOnly() {
  float v, b;
  samplePressureAdc(&v, &b);
  return b;
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
  if (P.F10 > 0.0001f) P.F10 *= mul;
  if (P.F11 > 0.0001f) P.F11 *= mul;
  P.F14 *= mul;
  P.F02 = clampF02(P.F02, next);
  P.F03 = clampF03(P.F03, next);
  P.F10 = clampF02AllowZero(P.F10, next);
  P.F11 = clampF02AllowZero(P.F11, next);
}

static void updateHyst(float p) {
  int n = P.F09;
  if (n < 1) n = 1;
  if (n > 3) n = 3;
  float d = P.F03;
  if (d < 0.05f) d = 0.05f;
  float ds = P.F04;
  if (ds < 0) ds = 0;
  const bool inv = (P.F22 != 0);
  for (int i = 0; i < 3; i++) {
    if (i >= n) {
      g_stageWant[i] = false;
      continue;
    }
    if (inv) {
      /* Alta presión: enciende etapa si P >= F02+F03−i·ds; apaga si P <= F02−i·ds (ej. set 18, dif 5 → ON ≥23, OFF ≤18). */
      const float onHigh = P.F02 + d - (float)i * ds;
      const float offLow = P.F02 - (float)i * ds;
      if (g_stageWant[i]) {
        if (p <= offLow) g_stageWant[i] = false;
      } else {
        if (p >= onHigh) g_stageWant[i] = true;
      }
    } else {
      float onTh = P.F02 - d * 0.5f - (float)i * ds;
      float offTh = P.F02 + d * 0.5f - (float)i * ds;
      if (g_stageWant[i]) {
        if (p > offTh) g_stageWant[i] = false;
      } else {
        if (p < onTh) g_stageWant[i] = true;
      }
    }
  }
}

/** Apaga relés y estado de emergencia por fallo de sensor (también tras F16 o recuperación). */
static void clearSensorEmergencyAndRelays(unsigned long nowMs) {
  g_alarmSensor = false;
  g_sensorInvalidSince = 0;
  g_sensorValidRecoverSince = 0;
  g_emergOnPhase = true;
  g_emergPhaseStartMs = 0;
  for (int phy = 0; phy < 3; phy++) {
    const int pin = REL_PINS[phy];
    if (relayIsOn(pin)) {
      relayWrite(pin, false);
      g_offSincePhys[phy] = nowMs;
      g_onSincePhys[phy] = 0;
    }
  }
}

/** F23>0: acumula ADC fuera de rango y hace latch; recuperación simétrica con tensión válida. */
static void updateSensorFault(float adcV, unsigned long nowMs) {
  if (P.F23 <= 0) {
    g_sensorInvalidSince = 0;
    g_sensorValidRecoverSince = 0;
    return;
  }
  if (!adcVoltageValid(adcV)) {
    g_sensorValidRecoverSince = 0;
    if (g_sensorInvalidSince == 0) g_sensorInvalidSince = nowMs;
    if (!g_alarmSensor && (nowMs - g_sensorInvalidSince >= (unsigned long)P.F23 * 1000UL)) {
      g_alarmSensor = true;
      g_emergOnPhase = true;
      g_emergPhaseStartMs = nowMs;
      Serial.printf("[SENS] Falla sensor/desconectado (ADC=%.2fV) → alarma + ciclo emergencia\n", adcV);
    }
    return;
  }
  g_sensorInvalidSince = 0;
  if (!g_alarmSensor) return;
  if (g_sensorValidRecoverSince == 0) g_sensorValidRecoverSince = nowMs;
  if (nowMs - g_sensorValidRecoverSince >= (unsigned long)P.F23 * 1000UL) {
    Serial.println(F("[SENS] Señal OK: se borra alarma de sensor."));
    clearSensorEmergencyAndRelays(nowMs);
  }
}

/** Con alarma de sensor: enciende 1..F09 juntos F24 s, apaga F25 s, repite. */
static void applyEmergencySensorCycle(unsigned long nowMs) {
  constexpr int N = 3;
  auto pinOf = [](int phy) { return REL_PINS[phy]; };
  int n = P.F09;
  if (n < 1) n = 1;
  if (n > N) n = N;
  const unsigned long ton = (unsigned long)max(10, P.F24) * 1000UL;
  const unsigned long toff = (unsigned long)max(10, P.F25) * 1000UL;
  if (g_emergPhaseStartMs == 0) {
    g_emergPhaseStartMs = nowMs;
    g_emergOnPhase = true;
  }
  const unsigned long el = nowMs - g_emergPhaseStartMs;
  if (g_emergOnPhase) {
    if (el >= ton) {
      for (int phy = 0; phy < N; phy++) {
        const int pin = pinOf(phy);
        relayWrite(pin, false);
        g_offSincePhys[phy] = nowMs;
        g_onSincePhys[phy] = 0;
      }
      g_emergOnPhase = false;
      g_emergPhaseStartMs = nowMs;
      return;
    }
    for (int phy = 0; phy < n; phy++) {
      const int pin = pinOf(phy);
      if (!relayIsOn(pin)) {
        relayWrite(pin, true);
        g_onSincePhys[phy] = nowMs;
      }
    }
    return;
  }
  for (int phy = 0; phy < N; phy++) {
    const int pin = pinOf(phy);
    relayWrite(pin, false);
    if (g_onSincePhys[phy] != 0) g_offSincePhys[phy] = nowMs;
    g_onSincePhys[phy] = 0;
  }
  if (el >= toff) {
    g_emergOnPhase = true;
    g_emergPhaseStartMs = nowMs;
  }
}

/** Alarmas por tiempo sobre umbrales F10/F11; F16=1 borra latch y guarda params. */
static void updateSafety(float p, unsigned long nowMs) {
  if (P.F16 >= 0.5f) {
    g_alarmLow = false;
    g_alarmHigh = false;
    g_lowCondSince = g_highCondSince = 0;
    clearSensorEmergencyAndRelays(nowMs);
    P.F16 = 0;
    saveParams();
    return;
  }
  if (P.F10 > 0.0001f && P.F12 > 0) {
    if (p < P.F10) {
      if (g_lowCondSince == 0) g_lowCondSince = nowMs;
      else if (!g_alarmLow && (nowMs - g_lowCondSince >= (unsigned long)P.F12 * 1000UL)) g_alarmLow = true;
    } else {
      g_lowCondSince = 0;
    }
  } else {
    g_lowCondSince = 0;
  }
  if (P.F11 > 0.0001f && P.F13 > 0) {
    if (p > P.F11) {
      if (g_highCondSince == 0) g_highCondSince = nowMs;
      else if (!g_alarmHigh && (nowMs - g_highCondSince >= (unsigned long)P.F13 * 1000UL)) g_alarmHigh = true;
    } else {
      g_highCondSince = 0;
    }
  } else {
    g_highCondSince = 0;
  }
}

/** Rotación de “lead”: etapa lógica 0→relé físico distinto cada F08 h (sin compresores en marcha). */
static void maybeRotateCompressors(unsigned long nowMs) {
  if (P.F08 <= 0) {
    g_nextRotAtMs = 0;
    return;
  }
  const unsigned long per = (unsigned long)P.F08 * 3600000UL;
  if (per == 0) return;
  if (g_nextRotAtMs == 0) g_nextRotAtMs = nowMs + per;
  if ((long)(nowMs - g_nextRotAtMs) < 0) return;
  const bool anyOn = relayIsOn(PIN_R1) || relayIsOn(PIN_R2) || relayIsOn(PIN_R3);
  if (anyOn) return;
  g_stageRot = (g_stageRot + 1) % 3;
  g_nextRotAtMs = nowMs + per;
  Serial.printf("[ROT] lead_rot=%d próximo_cambio_ms=%lu\n", g_stageRot, (unsigned long)g_nextRotAtMs);
}

static void applyRelays(unsigned long nowMs) {
  constexpr int N = 3;
  auto pinOf = [](int phy) { return REL_PINS[phy]; };
  if (P.F01 == 0) {
    for (int phy = 0; phy < N; phy++) {
      const int pin = pinOf(phy);
      if (relayIsOn(pin)) {
        relayWrite(pin, false);
        g_offSincePhys[phy] = nowMs;
        g_onSincePhys[phy] = 0;
      }
    }
    g_emergPhaseStartMs = 0;
    g_emergOnPhase = true;
    return;
  }
  if (g_alarmSensor) {
    applyEmergencySensorCycle(nowMs);
    return;
  }
  if (g_alarmLow || g_alarmHigh) {
    for (int phy = 0; phy < N; phy++) {
      const int pin = pinOf(phy);
      if (relayIsOn(pin)) {
        relayWrite(pin, false);
        g_offSincePhys[phy] = nowMs;
        g_onSincePhys[phy] = 0;
      }
    }
    return;
  }
  bool wantAutoPhys[N] = {false, false, false};
  for (int log = 0; log < N; log++) {
    if (log < P.F09 && g_stageWant[log]) {
      const int phy = (log + g_stageRot) % N;
      wantAutoPhys[phy] = true;
    }
  }
  bool targetPhys[N];
  for (int phy = 0; phy < N; phy++) {
    targetPhys[phy] = wantAutoPhys[phy];
    if (phy == 0 && P.F17 >= 0.5f) targetPhys[phy] = true;
    if (phy == 1 && P.F18 >= 0.5f) targetPhys[phy] = true;
    if (phy == 2 && P.F19 >= 0.5f) targetPhys[phy] = true;
  }

  const uint32_t minOff = (uint32_t)max(0, P.F06) * 1000UL;
  const uint32_t minOn = (uint32_t)max(0, P.F07) * 1000UL;
  const uint32_t gap = (uint32_t)max(0, P.F05) * 1000UL;
  for (int phy = 0; phy < N; phy++) {
    const int pin = pinOf(phy);
    const bool cur = relayIsOn(pin);
    const bool want = targetPhys[phy];
    if (cur == want) continue;
    if (want) {
      const bool manualOn =
          (phy == 0 && P.F17 >= 0.5f) || (phy == 1 && P.F18 >= 0.5f) || (phy == 2 && P.F19 >= 0.5f);
      const bool offOk = manualOn || (g_offSincePhys[phy] == 0) || (nowMs - g_offSincePhys[phy] >= minOff);
      const bool gapOk = manualOn || (g_lastStartMs == 0) || (nowMs - g_lastStartMs >= gap);
      if (!offOk || !gapOk) continue;
      relayWrite(pin, true);
      g_onSincePhys[phy] = nowMs;
      g_lastStartMs = nowMs;
    } else {
      const bool onOk = (g_onSincePhys[phy] == 0) || (nowMs - g_onSincePhys[phy] >= minOn);
      if (!onOk) continue;
      relayWrite(pin, false);
      g_offSincePhys[phy] = nowMs;
      g_onSincePhys[phy] = 0;
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
  const unsigned long now = millis();
  if (cloudInCooldown(now)) return;
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
  client.setTimeout(CLOUD_CLIENT_TIMEOUT_MS);
  HTTPClient http;
  http.setTimeout(CLOUD_CLIENT_TIMEOUT_MS);
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
  d["r4_alarm"] = (g_alarmLow || g_alarmHigh || g_alarmSensor);
  String body;
  serializeJson(d, body);
  int code = http.POST(body);
  if (code >= 0) {
    Serial.printf("[TX] HTTP %d\n", code);
    if (code >= 400) {
      String resp = http.getString();
      if (resp.length() > 220) resp = resp.substring(0, 220) + "...";
      Serial.printf("[TX] body=%s\n", resp.c_str());
    }
    g_lastTxErrLogMs = 0;
  } else {
    g_lastCloudFailMs = now;
    applyPublicDnsIfStaUp();
    if (g_lastTxErrLogMs == 0 || (now - g_lastTxErrLogMs > 20000UL)) {
      g_lastTxErrLogMs = now;
      Serial.printf("[TX] HTTP %d err=%s url=%s\n", code, http.errorToString(code).c_str(), g_cfg.apiUrl);
      Serial.printf("[TX] WiFi.status=%d RSSI=%d | cooldown=%lus | serie: net (diagnostico)\n", (int)WiFi.status(),
                    (int)WiFi.RSSI(), (unsigned long)(CLOUD_COOLDOWN_MS / 1000UL));
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
  if (src.containsKey("F01")) {
    const int nv = normalizeF01FromFloat(src["F01"].as<float>());
    if (nv != P.F01) {
      P.F01 = nv;
      ch = true;
    }
  }
  applyFloat("F02", P.F02);
  applyFloat("F03", P.F03);
  applyFloat("F04", P.F04);
  applyInt("F05", P.F05);
  applyInt("F06", P.F06);
  applyInt("F07", P.F07);
  applyInt("F08", P.F08);
  applyInt("F09", P.F09);
  if (src.containsKey("F10")) {
    float v = src["F10"].as<float>();
    float c = clampF02AllowZero(v, P.F15);
    if (c != P.F10) {
      P.F10 = c;
      ch = true;
    }
  }
  if (src.containsKey("F11")) {
    float v = src["F11"].as<float>();
    float c = clampF02AllowZero(v, P.F15);
    if (c != P.F11) {
      P.F11 = c;
      ch = true;
    }
  }
  applyInt("F12", P.F12);
  applyInt("F13", P.F13);
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
  applyInt("F20", P.F20);
  if (src.containsKey("F21")) {
    const int n21 = normalizeF01FromFloat(src["F21"].as<float>());
    if (n21 != P.F21) {
      P.F21 = n21;
      ch = true;
    }
  }
  /* F16=1 desde la app: pulso de reset (no se guarda F16=1 en flash; solo borra latch). */
  if (src.containsKey("F16") && normalizeF01FromFloat(src["F16"].as<float>()) != 0) {
    g_alarmLow = false;
    g_alarmHigh = false;
    g_lowCondSince = g_highCondSince = 0;
    clearSensorEmergencyAndRelays(millis());
    P.F16 = 0;
    ch = true;
  }
  if (src.containsKey("F22")) {
    const int nv = normalizeF01FromFloat(src["F22"].as<float>());
    if (nv != P.F22) {
      P.F22 = nv;
      ch = true;
    }
  }
  applyInt("F23", P.F23);
  applyInt("F24", P.F24);
  applyInt("F25", P.F25);
  applyFloat("F26", P.F26);
  applyFloat("F27", P.F27);
  if (P.F09 < 1) P.F09 = 1;
  if (P.F09 > 3) P.F09 = 3;
  {
    const int n = normalizeF01FromFloat((float)P.F01);
    if (n != P.F01) ch = true;
    P.F01 = n;
  }
  {
    const int n22 = normalizeF01FromFloat((float)P.F22);
    if (n22 != P.F22) ch = true;
    P.F22 = n22;
  }
  {
    const float c = clampF02(P.F02, P.F15);
    if (c != P.F02) {
      P.F02 = c;
      ch = true;
    }
  }
  {
    const float c3 = clampF03(P.F03, P.F15);
    if (c3 != P.F03) {
      P.F03 = c3;
      ch = true;
    }
  }
  if (P.F08 < 0) {
    P.F08 = 0;
    ch = true;
  }
  if (P.F08 > 8760) {
    P.F08 = 8760;
    ch = true;
  }
  if (P.F12 < 1) {
    P.F12 = 1;
    ch = true;
  }
  if (P.F12 > 3600) {
    P.F12 = 3600;
    ch = true;
  }
  if (P.F13 < 1) {
    P.F13 = 1;
    ch = true;
  }
  if (P.F13 > 3600) {
    P.F13 = 3600;
    ch = true;
  }
  if (P.F20 < 0) {
    P.F20 = 0;
    ch = true;
  }
  if (P.F20 > 999) {
    P.F20 = 999;
    ch = true;
  }
  {
    const float c10 = clampF02AllowZero(P.F10, P.F15);
    if (c10 != P.F10) {
      P.F10 = c10;
      ch = true;
    }
  }
  {
    const float c11 = clampF02AllowZero(P.F11, P.F15);
    if (c11 != P.F11) {
      P.F11 = c11;
      ch = true;
    }
  }
  {
    const int n21 = normalizeF01FromFloat((float)P.F21);
    if (n21 != P.F21) ch = true;
    P.F21 = n21;
  }
  if (P.F23 < 0) {
    P.F23 = 0;
    ch = true;
  } else if (P.F23 > 0 && P.F23 < 5) {
    P.F23 = 5;
    ch = true;
  } else if (P.F23 > 600) {
    P.F23 = 600;
    ch = true;
  }
  if (P.F24 < 10) {
    P.F24 = 10;
    ch = true;
  }
  if (P.F24 > 7200) {
    P.F24 = 7200;
    ch = true;
  }
  if (P.F25 < 10) {
    P.F25 = 10;
    ch = true;
  }
  if (P.F25 > 7200) {
    P.F25 = 7200;
    ch = true;
  }
  if (P.F23 <= 0 && g_alarmSensor) {
    clearSensorEmergencyAndRelays(millis());
    ch = true;
  }
  clampAdcThresholds();
  return ch;
}

static void tryPullParamsFromCloud() {
  if (WiFi.status() != WL_CONNECTED) return;
  const unsigned long now = millis();
  if (cloudInCooldown(now)) return;
  if (!strlen(g_cfg.moduleId) || !strlen(g_cfg.apiKey)) return;
  char url[220]{};
  if (!buildFetchParamsUrl(url, sizeof(url))) return;
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(CLOUD_CLIENT_TIMEOUT_MS);
  HTTPClient http;
  http.setTimeout(CLOUD_CLIENT_TIMEOUT_MS);
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
  if (code != 200) {
    if (code < 0) g_lastCloudFailMs = now;
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
  Serial.printf("[PRM] F01=%d F15=%d F22=%d F02=%.2f F03=%.2f F04=%.2f F05=%d F06=%d F07=%d F08=%d F09=%d\n", P.F01,
                P.F15, P.F22, P.F02, P.F03, P.F04, P.F05, P.F06, P.F07, P.F08, P.F09);
  Serial.printf("[PRM] F10=%.2f F11=%.2f F12=%d F13=%d F14=%.3f F16=%d F20=%d F21=%d rot=%d almL=%d almH=%d almS=%d\n",
                P.F10, P.F11, P.F12, P.F13, P.F14, P.F16, P.F20, P.F21, g_stageRot, (int)g_alarmLow, (int)g_alarmHigh,
                (int)g_alarmSensor);
  Serial.printf("[PRM] F23=%d (s conf. falla ADC; 0=off) F24=%d F25=%d (ciclo ON/OFF emerg.)\n", P.F23, P.F24, P.F25);
  Serial.printf("[PRM] F26=%.3fV F27=%.3fV (ventana ADC válida)\n", P.F26, P.F27);
  Serial.printf("[PRM] manual F17=%.2f F18=%.2f F19=%.2f (>=0.5=ON relé C1/C2/C3; en app o serie: set f17 1)\n", P.F17, P.F18, P.F19);
  if (P.F01 < 1 && (P.F17 >= 0.5f || P.F18 >= 0.5f || P.F19 >= 0.5f)) {
    Serial.println(F("[PRM] !! F01=0 (desarmado): F17/F18/F19 no pueden prender relés. En app o serie: set f01 1"));
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
    Serial.println(F("Uso: set f01 0|1 | set f17 1 | set f02 2.5 | ..."));
    return;
  }
  String key = rest.substring(0, sp);
  String valStr = rest.substring(sp + 1);
  valStr.trim();
  float v = valStr.toFloat();
  if (key == "f01") P.F01 = normalizeF01FromFloat(v);
  else if (key == "f02") P.F02 = clampF02(v, P.F15);
  else if (key == "f03") P.F03 = clampF03(v, P.F15);
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
  else if (key == "f08") P.F08 = (int)v;
  else if (key == "f10") P.F10 = clampF02AllowZero(v, P.F15);
  else if (key == "f11") P.F11 = clampF02AllowZero(v, P.F15);
  else if (key == "f12") P.F12 = (int)v;
  else if (key == "f13") P.F13 = (int)v;
  else if (key == "f16") P.F16 = normalizeF01FromFloat(v);
  else if (key == "f20") P.F20 = (int)v;
  else if (key == "f21") P.F21 = normalizeF01FromFloat(v);
  else if (key == "f22") P.F22 = normalizeF01FromFloat(v);
  else if (key == "f23") P.F23 = (int)v;
  else if (key == "f24") P.F24 = (int)v;
  else if (key == "f25") P.F25 = (int)v;
  else if (key == "f26") P.F26 = v;
  else if (key == "f27") P.F27 = v;
  else {
    Serial.println(
        F("Claves: f01…f27 (f26/f27=V min/max ADC válido; f23=0 off falla sensor; f24/f25 ciclo emerg. s)"));
    return;
  }
  if (P.F09 < 1) P.F09 = 1;
  if (P.F09 > 3) P.F09 = 3;
  if (P.F08 < 0) P.F08 = 0;
  if (P.F08 > 8760) P.F08 = 8760;
  if (P.F12 < 1) P.F12 = 1;
  if (P.F12 > 3600) P.F12 = 3600;
  if (P.F13 < 1) P.F13 = 1;
  if (P.F13 > 3600) P.F13 = 3600;
  if (P.F20 < 0) P.F20 = 0;
  if (P.F20 > 999) P.F20 = 999;
  P.F10 = clampF02AllowZero(P.F10, P.F15);
  P.F11 = clampF02AllowZero(P.F11, P.F15);
  P.F16 = normalizeF01FromFloat((float)P.F16);
  P.F21 = normalizeF01FromFloat((float)P.F21);
  if (P.F23 < 0) P.F23 = 0;
  else if (P.F23 > 0 && P.F23 < 5) P.F23 = 5;
  else if (P.F23 > 600) P.F23 = 600;
  if (P.F24 < 10) P.F24 = 10;
  if (P.F24 > 7200) P.F24 = 7200;
  if (P.F25 < 10) P.F25 = 10;
  if (P.F25 > 7200) P.F25 = 7200;
  if (P.F23 <= 0) clearSensorEmergencyAndRelays(millis());
  clampAdcThresholds();
  saveParams();
  Serial.println(F("[PRM] OK guardado en flash."));
  printParams();
}

static void printStatus() {
  Serial.printf("[WiFi] status=%d SSID=%s IP=%s RSSI=%d\n", (int)WiFi.status(),
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  Serial.printf("[PR500] P=%.2f%s telem=%.2fbar ARM=%d F22=%d SP=%.2f D=%.2f ST=%.2f F15=%d comps=%d\n",
                pressureReadingControlUnit(), (P.F15 != 0) ? "psi" : "bar", pressureBarTelemetry(), P.F01, P.F22, P.F02,
                P.F03, P.F04, P.F15, P.F09);
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
  if (P.F08 > 0) g_nextRotAtMs = millis() + (unsigned long)P.F08 * 3600000UL;
  else {
    g_nextRotAtMs = 0;
    g_stageRot = 0;
  }
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
  const unsigned long nowMs = millis();
  float adcV, barRaw;
  samplePressureAdc(&adcV, &barRaw);
  const float p =
      (P.F15 == 0) ? (barRaw + P.F14) : (barRaw * PSI_PER_BAR + P.F14);
  updateSensorFault(adcV, nowMs);
  if (adcVoltageValid(adcV)) {
    updateSafety(p, nowMs);
  } else {
    g_lowCondSince = 0;
    g_highCondSince = 0;
  }
  if (!g_alarmSensor) maybeRotateCompressors(nowMs);
  if (!g_alarmSensor) updateHyst(p);
  applyRelays(nowMs);

  if (nowMs - g_lastSendMs >= g_cfg.intervalMs) {
    g_lastSendMs = nowMs;
    sendIngest();
  }
  if (WiFi.status() == WL_CONNECTED && strlen(g_cfg.moduleId) && strlen(g_cfg.apiKey)) {
    if (nowMs - g_lastParamsPullMs >= g_cfg.paramsPullMs) {
      g_lastParamsPullMs = nowMs;
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

