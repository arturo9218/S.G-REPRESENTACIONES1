/**
 * ESP32 — PR500 · presión + relés / entradas → Supabase Edge Function `ingest-reading`.
 *
 * Sin pantalla ni botones: la configuración es por (1) Web Bluetooth (Chrome/Edge, F01–F21) y/o (2) portal WiFi
 * del ESP (SSID `PR500-Config`). Ese portal es una red **local del equipo**: el celular se conecta al ESP; **no**
 * hace falta que el modem/router tenga salida a Internet para entrar al formulario (sí hace falta Internet después
 * si querés subir lecturas a Supabase). Para reabrir el portal con WiFi ya guardado: **GPIO 14 a GND al encender**.
 *
 * Placa: ESP32 con BLE (p. ej. ESP32-WROOM-32). No sirve ESP32-S2 (sin BLE).
 * Arduino IDE: placa "ESP32 Dev Module" o la tuya.
 * Partición: el sketch supera ~1,2 MB de app. En Herramientas → Esquema de partición elegí una con
 *   APP ≥ ~2 MB (ej. "Huge APP (3MB No OTA/1MB SPIFFS)" o "Minimal SPIFFS (1.9MB APP con OTA/…)" en flash 4 MB).
 * Si compilás con "Default 4MB with spiffs (1.2MB APP)" verás error «text section exceeds available space».
 *
 * Librerías (instalar con el gestor de librerías):
 *   - WiFiManager (tzapu)
 *   - ArduinoJson v6.x (compatible con v7 si cambiás el bucle JsonPair por el de tu versión)
 *   - LittleFS incluido en el core ESP32
 *
 * Primera instalación: subir este sketch por USB. Después podés actualizar firmware por WiFi
 * (OTA HTTPS) si configurás `ota_firmware_url` en /config.json o con el portal WiFiManager.
 *
 * /config.json (LittleFS) — también se puede generar desde el portal "Config PR500":
 * {
 *   "api_url": "https://PROYECTO.supabase.co/functions/v1/ingest-reading",
 *   "module_id": "PR5-xxxxxxxx",
 *   "api_key": "123456",
 *   "supabase_anon_key": "opcional si tu función exige header apikey",
 *   "interval_ms": 20000,
 *   "adc_pin": 36,
 *   "pressure_v_min": 0.5,
 *   "pressure_v_max": 3.0,
 *   "pressure_bar_min": 0.0,
 *   "pressure_bar_max": 8.0,
 *   "ota_firmware_url": "https://.../pr500_firmware.bin",
 *   "ota_check_hours": 0,
 *   "params_pull_ms": 120000
 * }
 * params_pull_ms: intervalo para traer F01–F21 desde la nube (Edge `fetch-pr500-params`). 0 = desactivado.
 * La URL se deduce de api_url reemplazando `ingest-reading` por `fetch-pr500-params` (mismo proyecto Supabase).
 * ota_check_hours: 0 = solo OTA manual (comando serial `ota`). >0 = intento cada N horas (cuidado: misma URL re-flashea).
 *
 * Pines por defecto (DevKit ESP32-WROOM; ajustá a tu PCB):
 *   ADC presión: GPIO36 (ADC1_CH0, solo entrada; OK con WiFi).
 *   Salidas relés C1–C3 (HIGH = ON): 25, 26, 32
 *   Entradas DI1–DI4: GPIO33 con pull-up interno; GPIO34/35/39 son solo entrada (sin PU interna en el chip)
 *   — usan pinMode INPUT; si usás esas líneas, ponelas a 3,3 V con resistencia externa (~10k) cuando “sueltas”.
 *   Pin portal WiFi forzado: 14 (GND al arranque = abrir AP de configuración)
 *
 * Serial 115200: abrí el Monitor **después** de subir el sketch (o pulsá RESET con el monitor abierto).
 *   Si no ves texto: misma velocidad **115200 baud**, puerto COM correcto, cable con datos (no solo carga).
 * Comandos: `status`, `ota` (si hay OTA en el build), `reboot`.
 *
 * Bluetooth LE: nombre de anuncio `PR500-xxxx` (Web Bluetooth en la app). Servicio / parámetros F01–F21
 * en /pr500_params.json (mismo JSON que la nube). Ver `pr500-ble.service.ts` (UUIDs).
 * BLE arranca **en seguida** tras montar LittleFS (antes del portal WiFi). Así el nombre `PR500-xxxx` aparece aunque
 *   el portal tarde o bloquee; si el AP `PR500-Config` se cae en el celular, probá apagar datos móviles o acercar el ESP.
 * PR500_SMALL_FLASH_BUILD=1: sin BLE en el binario (solo emergencia si no hay partición grande).
 *
 * Regulación (alineada a pr500-sections.ts en Angular):
 *   F02 setpoint, F03 diferencial general, F04 entre etapas, F09 1–3 compresores.
 *   Histéresis por etapa: ON si P < F02 - F03/2 - i*F04; OFF si P > F02 + F03/2 - i*F04 (P en bar o psi según F15).
 *   F05 retardo entre arranques, F06 mín. apagado, F07 mín. encendido (s). F08 rotación de lead cada N h (entre etapas).
 *   F10/F11 presión mín/máx seguridad; F12/F13 segundos antes de alarma (r4); F16 != 0 borra alarma.
 *   F17–F19 manual por compresor físico C1–C3 (1 = fuerza ON; alarma de seguridad apaga todo).
 *   F14 offset en bar sobre la lectura escalada; F01/F20 no afectan relés. F21: si 0, no OTA automático por horas.
 *
 * Tamaño del programa:
 *   Uso previsto **con BLE** (sin display): partición «Huge APP (3MB No OTA/1MB SPIFFS)» y PR500_SMALL_FLASH_BUILD=0.
 *   Solo si no podés usar Huge APP: PR500_SMALL_FLASH_BUILD=1 (sin BLE ni OTA HTTP; tendrías que usar solo portal + nube).
 */

/** 0 = BLE + OTA HTTP (recomendado; partición Huge APP). 1 = sin BLE/OTA HTTP (solo cabe en ~1,2 MB APP). */
#define PR500_SMALL_FLASH_BUILD 0
#if PR500_SMALL_FLASH_BUILD
#define PR500_FEATURE_BLE 0
#define PR500_FEATURE_OTA_HTTP 0
#else
#define PR500_FEATURE_BLE 1
#define PR500_FEATURE_OTA_HTTP 1
#endif

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <time.h>
#if PR500_FEATURE_OTA_HTTP
#include <HTTPUpdate.h>
#endif
#if PR500_FEATURE_BLE
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#endif

static const char *PARAMS_PATH = "/pr500_params.json";
static const char *CLOUD_PARAMS_AT_PATH = "/pr500_cloud_params_at.txt";
#if PR500_FEATURE_BLE
#define PR500_BLE_SERVICE_UUID "12345678-1234-1234-1234-123456789001"
#define PR500_BLE_CHAR_RX_UUID "12345678-1234-1234-1234-123456789002"
#define PR500_BLE_CHAR_TX_UUID "12345678-1234-1234-1234-123456789003"
#endif

static const char *DEFAULT_PARAMS_JSON =
  "{\"F01\":0,\"F02\":2.0,\"F03\":0.5,\"F04\":0.4,\"F05\":30,\"F06\":120,\"F07\":180,\"F08\":24,\"F09\":3,"
  "\"F10\":0.5,\"F11\":15,\"F12\":60,\"F13\":60,\"F14\":0,\"F15\":0,\"F16\":0,\"F17\":0,\"F18\":0,\"F19\":0,\"F20\":1,\"F21\":0}";

#if PR500_FEATURE_BLE
static BLECharacteristic *gBleCharTx = nullptr;
static String gBleRxAccum;
#endif

static const char *CFG_PATH = "/config.json";
static const char *AP_NAME = "PR500-Config";

// ---------- Pines hardware (cambiar según esquema) ----------
static const uint8_t PIN_PRESSURE_ADC = 36;  // ADC1
static const int PIN_RELAY_C1 = 25;
static const int PIN_RELAY_C2 = 26;
static const int PIN_RELAY_C3 = 32;
static const int PIN_DI1 = 33;
static const int PIN_DI2 = 34;
static const int PIN_DI3 = 35;
static const int PIN_DI4 = 39;
static const int PIN_FORCE_PORTAL = 14;

// ---------- Config ----------
struct Cfg {
  char apiUrl[200]{};
  char moduleId[48]{};
  char apiKey[24]{};
  char supabaseAnonKey[400]{};
  uint32_t intervalMs = 20000;
  uint8_t adcPin = PIN_PRESSURE_ADC;
  float pressureVmin = 0.5f;
  float pressureVmax = 3.0f;
  float pressureBarMin = 0.0f;
  float pressureBarMax = 8.0f;
  char otaFirmwareUrl[200]{};
  uint32_t otaCheckHours = 0;  // 0 = no auto; >0 = horas entre chequeos
  /** 0 = no descargar params desde la nube; por defecto 120000 ms. */
  uint32_t paramsPullMs = 120000;
};

static Cfg g_cfg;
static bool ensureLittleFS();
static float pressureBarFromAdc();
static WiFiManager wm;
static WiFiManagerParameter p_api("apiurl", "URL ingest-reading (https://...)", "", 200);
static WiFiManagerParameter p_mod("modid", "module_id (PR5-...)", "", 48);
static WiFiManagerParameter p_key("apikey", "api_key 6 digitos", "", 16);
static WiFiManagerParameter p_anon("anon", "Supabase anon (opcional)", "", 400);
static WiFiManagerParameter p_ota("otaurl", "URL firmware .bin OTA (opcional)", "", 200);

static unsigned long g_lastSend = 0;
static unsigned long g_lastOtaCheck = 0;
static unsigned long g_lastParamsCloudPullMs = 0;
#if PR500_FEATURE_BLE
static unsigned long g_lastBleAdvKickMs = 0;
#endif
static bool g_fsOk = false;

// ---------- Parámetros PR500 F01–F21 + estado de control ----------
struct Pr500Params {
  float F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20, F21;
};

static Pr500Params g_pr{};
static unsigned long g_lastPrReloadMs = 0;
static bool g_r4Alarm = false;
static unsigned long g_alarmLowSinceMs = 0;
static unsigned long g_alarmHighSinceMs = 0;
/** Histéresis lógica etapa 0..2 (antes de rotación). */
static bool g_stageWant[3] = {false, false, false};
static unsigned long g_relayOnSinceMs[3] = {0, 0, 0};
static unsigned long g_relayOffSinceMs[3] = {0, 0, 0};
static unsigned long g_lastAnyCompStartMs = 0;

static const int REL_PINS[3] = {PIN_RELAY_C1, PIN_RELAY_C2, PIN_RELAY_C3};

static constexpr float PSI_PER_BAR = 14.5037738f;

static void pr500ParamsFromDefaults(Pr500Params *p) {
  StaticJsonDocument<896> doc;
  (void)deserializeJson(doc, DEFAULT_PARAMS_JSON);
  JsonObject o = doc.as<JsonObject>();
  p->F01 = o["F01"] | 0.f;
  p->F02 = o["F02"] | 2.f;
  p->F03 = o["F03"] | 0.5f;
  p->F04 = o["F04"] | 0.4f;
  p->F05 = o["F05"] | 30.f;
  p->F06 = o["F06"] | 120.f;
  p->F07 = o["F07"] | 180.f;
  p->F08 = o["F08"] | 24.f;
  p->F09 = o["F09"] | 3.f;
  p->F10 = o["F10"] | 0.5f;
  p->F11 = o["F11"] | 15.f;
  p->F12 = o["F12"] | 60.f;
  p->F13 = o["F13"] | 60.f;
  p->F14 = o["F14"] | 0.f;
  p->F15 = o["F15"] | 0.f;
  p->F16 = o["F16"] | 0.f;
  p->F17 = o["F17"] | 0.f;
  p->F18 = o["F18"] | 0.f;
  p->F19 = o["F19"] | 0.f;
  p->F20 = o["F20"] | 1.f;
  p->F21 = o["F21"] | 0.f;
}

static void mergePr500FromJsonObject(JsonObject o, Pr500Params *p) {
  if (!o) return;
#define M(F) \
  if (o.containsKey(#F)) p->F = o[#F].as<float>();
  M(F01);
  M(F02);
  M(F03);
  M(F04);
  M(F05);
  M(F06);
  M(F07);
  M(F08);
  M(F09);
  M(F10);
  M(F11);
  M(F12);
  M(F13);
  M(F14);
  M(F15);
  M(F16);
  M(F17);
  M(F18);
  M(F19);
  M(F20);
  M(F21);
#undef M
}

static void reloadPr500ParamsIfDue(unsigned long nowMs) {
  if (g_lastPrReloadMs != 0 && (nowMs - g_lastPrReloadMs < 500UL)) return;
  g_lastPrReloadMs = nowMs;
  Pr500Params tmp{};
  pr500ParamsFromDefaults(&tmp);
  if (ensureLittleFS() && LittleFS.exists(PARAMS_PATH)) {
    File f = LittleFS.open(PARAMS_PATH, "r");
    if (f) {
      StaticJsonDocument<896> doc;
      if (!deserializeJson(doc, f)) mergePr500FromJsonObject(doc.as<JsonObject>(), &tmp);
      f.close();
    }
  }
  g_pr = tmp;
}

/** Presión escalada (bar según config.json) + offset F14 (bar). */
static float pressureBarAdjusted() { return pressureBarFromAdc() + g_pr.F14; }

/** Valor de proceso para umbrales: bar si F15==0, psi si F15!=0. */
static float pressureForThresholds(float pBarAdj) {
  if (g_pr.F15 >= 0.5f) return pBarAdj * PSI_PER_BAR;
  return pBarAdj;
}

static int compressorCount() {
  int n = (int)(g_pr.F09 + 0.5f);
  if (n < 1) n = 1;
  if (n > 3) n = 3;
  return n;
}

static int leadIndex(int nComp) {
  if (nComp < 2) return 0;
  unsigned long fh = (unsigned long)max(1.f, g_pr.F08);
  unsigned long periodMs = fh * 3600000UL;
  unsigned slot = (millis() / periodMs) % (unsigned)nComp;
  return (int)slot;
}

static void updateStageHysteresis(float pUser) {
  const int n = compressorCount();
  const float sp = g_pr.F02;
  const float d = max(0.05f, g_pr.F03);
  const float ds = max(0.0f, g_pr.F04);
  for (int i = 0; i < 3; i++) {
    if (i >= n) {
      g_stageWant[i] = false;
      continue;
    }
    const float onTh = sp - d * 0.5f - (float)i * ds;
    const float offTh = sp + d * 0.5f - (float)i * ds;
    if (g_stageWant[i]) {
      if (pUser > offTh) g_stageWant[i] = false;
    } else {
      if (pUser < onTh) g_stageWant[i] = true;
    }
  }
}

static void mapLogicalToPhysical(bool outPhys[3], int n, int lead) {
  for (int k = 0; k < 3; k++) outPhys[k] = false;
  for (int log = 0; log < n; log++) {
    const int pidx = (lead + log) % 3;
    outPhys[pidx] = g_stageWant[log];
  }
}

static void applyRelayOutputs(unsigned long nowMs) {
  const uint32_t minOffMs = (uint32_t)max(0.f, g_pr.F06) * 1000UL;
  const uint32_t minOnMs = (uint32_t)max(0.f, g_pr.F07) * 1000UL;
  const uint32_t startGapMs = (uint32_t)max(0.f, g_pr.F05) * 1000UL;

  bool physAuto[3];
  mapLogicalToPhysical(physAuto, compressorCount(), leadIndex(compressorCount()));

  bool target[3];
  for (int k = 0; k < 3; k++) {
    target[k] = physAuto[k];
    if (g_pr.F17 >= 0.5f) target[k] = (k == 0) ? true : target[k];
    if (g_pr.F18 >= 0.5f) target[k] = (k == 1) ? true : target[k];
    if (g_pr.F19 >= 0.5f) target[k] = (k == 2) ? true : target[k];
  }

  if (g_r4Alarm) {
    for (int k = 0; k < 3; k++) target[k] = false;
  }

  for (int k = 0; k < 3; k++) {
    const bool cur = digitalRead(REL_PINS[k]) == HIGH;
    const int pin = REL_PINS[k];
    if (target[k] == cur) continue;

    if (target[k]) {
      const bool offOk = (g_relayOffSinceMs[k] == 0) || (nowMs - g_relayOffSinceMs[k] >= minOffMs);
      const bool gapOk = (g_lastAnyCompStartMs == 0) || (nowMs - g_lastAnyCompStartMs >= startGapMs);
      if (!offOk || !gapOk) continue;
      digitalWrite(pin, HIGH);
      g_relayOnSinceMs[k] = nowMs;
      g_lastAnyCompStartMs = nowMs;
    } else {
      const bool onOk = (g_relayOnSinceMs[k] == 0) || (nowMs - g_relayOnSinceMs[k] >= minOnMs);
      if (!onOk) continue;
      digitalWrite(pin, LOW);
      g_relayOffSinceMs[k] = nowMs;
      g_relayOnSinceMs[k] = 0;
    }
  }
}

static void pr500ControlTick(unsigned long nowMs) {
  reloadPr500ParamsIfDue(nowMs);

  if (g_pr.F16 >= 0.5f) {
    g_r4Alarm = false;
    g_alarmLowSinceMs = 0;
    g_alarmHighSinceMs = 0;
  }

  const float pBar = pressureBarAdjusted();
  const float pUser = pressureForThresholds(pBar);

  const float tLowMs = max(0.f, g_pr.F12) * 1000.f;
  const float tHighMs = max(0.f, g_pr.F13) * 1000.f;

  if (pUser < g_pr.F10) {
    if (g_alarmLowSinceMs == 0) g_alarmLowSinceMs = nowMs;
  } else {
    g_alarmLowSinceMs = 0;
  }
  if (pUser > g_pr.F11) {
    if (g_alarmHighSinceMs == 0) g_alarmHighSinceMs = nowMs;
  } else {
    g_alarmHighSinceMs = 0;
  }

  if (!g_r4Alarm && g_alarmLowSinceMs != 0 && tLowMs > 0 &&
      (nowMs - g_alarmLowSinceMs >= (unsigned long)tLowMs))
    g_r4Alarm = true;
  if (!g_r4Alarm && g_alarmHighSinceMs != 0 && tHighMs > 0 &&
      (nowMs - g_alarmHighSinceMs >= (unsigned long)tHighMs))
    g_r4Alarm = true;

  if (!g_r4Alarm) {
    updateStageHysteresis(pUser);
    applyRelayOutputs(nowMs);
  } else {
    for (int k = 0; k < 3; k++) {
      if (digitalRead(REL_PINS[k]) == HIGH) {
        digitalWrite(REL_PINS[k], LOW);
        g_relayOffSinceMs[k] = nowMs;
        g_relayOnSinceMs[k] = 0;
      }
    }
  }
}

static bool ensureLittleFS() {
  if (g_fsOk) return true;
  /* Tras cambiar «Esquema de partición» en el IDE suele quedar un FS viejo/corrupto: mount y si falla, formatear. */
  if (LittleFS.begin(false)) {
    g_fsOk = true;
    return true;
  }
  Serial.println(F("[FS] LittleFS corrupto o sin formato — formateando partición de datos…"));
  if (!LittleFS.format()) {
    Serial.println(F("[FS] LittleFS.format() falló (revisá partición / subí con «Borrar flash» una vez)."));
    return false;
  }
  if (!LittleFS.begin(false)) {
    Serial.println(F("[FS] LittleFS mount tras format falló"));
    return false;
  }
  g_fsOk = true;
  Serial.println(F("[FS] LittleFS OK (recién formateado; configurá de nuevo portal y config.json)."));
  return true;
}

static bool loadConfig() {
  if (!ensureLittleFS()) return false;
  if (!LittleFS.exists(CFG_PATH)) {
    Serial.println(F("[CFG] No config.json — portal WiFi la primera vez"));
    return false;
  }
  File f = LittleFS.open(CFG_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<1024> doc;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) {
    Serial.printf("[CFG] JSON error: %s\n", e.c_str());
    return false;
  }
  strlcpy(g_cfg.apiUrl, doc["api_url"] | "", sizeof(g_cfg.apiUrl));
  strlcpy(g_cfg.moduleId, doc["module_id"] | "", sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey, doc["api_key"] | "", sizeof(g_cfg.apiKey));
  strlcpy(g_cfg.supabaseAnonKey, doc["supabase_anon_key"] | "", sizeof(g_cfg.supabaseAnonKey));
  g_cfg.intervalMs = (uint32_t)(doc["interval_ms"] | 20000);
  if (g_cfg.intervalMs < 5000) g_cfg.intervalMs = 5000;
  g_cfg.adcPin = (uint8_t)(doc["adc_pin"] | (int)PIN_PRESSURE_ADC);
  g_cfg.pressureVmin = (float)(doc["pressure_v_min"] | 0.5);
  g_cfg.pressureVmax = (float)(doc["pressure_v_max"] | 3.0);
  g_cfg.pressureBarMin = (float)(doc["pressure_bar_min"] | 0.0);
  g_cfg.pressureBarMax = (float)(doc["pressure_bar_max"] | 8.0);
  strlcpy(g_cfg.otaFirmwareUrl, doc["ota_firmware_url"] | "", sizeof(g_cfg.otaFirmwareUrl));
  g_cfg.otaCheckHours = (uint32_t)(doc["ota_check_hours"] | 0);
  g_cfg.paramsPullMs = (uint32_t)(doc["params_pull_ms"] | 120000);
  return strlen(g_cfg.apiUrl) > 10 && strlen(g_cfg.moduleId) > 2 && strlen(g_cfg.apiKey) >= 4;
}

static bool saveConfigFromParams() {
  if (!ensureLittleFS()) return false;
  StaticJsonDocument<1024> doc;
  if (LittleFS.exists(CFG_PATH)) {
    File fr = LittleFS.open(CFG_PATH, "r");
    if (fr) {
      deserializeJson(doc, fr);
      fr.close();
    }
  }
  doc["api_url"] = p_api.getValue();
  doc["module_id"] = p_mod.getValue();
  doc["api_key"] = p_key.getValue();
  doc["supabase_anon_key"] = p_anon.getValue();
  if (!doc.containsKey("interval_ms")) doc["interval_ms"] = 20000;
  if (!doc.containsKey("adc_pin")) doc["adc_pin"] = PIN_PRESSURE_ADC;
  if (!doc.containsKey("pressure_v_min")) doc["pressure_v_min"] = 0.5;
  if (!doc.containsKey("pressure_v_max")) doc["pressure_v_max"] = 3.0;
  if (!doc.containsKey("pressure_bar_min")) doc["pressure_bar_min"] = 0.0;
  if (!doc.containsKey("pressure_bar_max")) doc["pressure_bar_max"] = 8.0;
  doc["ota_firmware_url"] = p_ota.getValue();
  if (!doc.containsKey("ota_check_hours")) doc["ota_check_hours"] = 0;
  if (!doc.containsKey("params_pull_ms")) doc["params_pull_ms"] = 120000;

  File f = LittleFS.open(CFG_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  Serial.println(F("[CFG] Guardado config.json"));
  return loadConfig();
}

static void setupPins() {
  pinMode(PIN_RELAY_C1, OUTPUT);
  pinMode(PIN_RELAY_C2, OUTPUT);
  pinMode(PIN_RELAY_C3, OUTPUT);
  digitalWrite(PIN_RELAY_C1, LOW);
  digitalWrite(PIN_RELAY_C2, LOW);
  digitalWrite(PIN_RELAY_C3, LOW);

  pinMode(PIN_DI1, INPUT_PULLUP);
  /* 34, 35, 39: pads solo entrada — el ESP32 no tiene pull-up interno; INPUT_PULLUP dispara error del driver. */
  pinMode(PIN_DI2, INPUT);
  pinMode(PIN_DI3, INPUT);
  pinMode(PIN_DI4, INPUT);
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
}

/** Voltaje aprox en el pin ADC (ESP32 ~ atenuación 11 dB = 0–3.3V rango útil). */
static float readAdcVoltage(uint8_t pin) {
  analogSetPinAttenuation(pin, ADC_11db);
  uint32_t acc = 0;
  for (int i = 0; i < 16; i++) {
    acc += analogRead(pin);
    delay(2);
  }
  float raw = acc / 16.0f;
  return (raw / 4095.0f) * 3.3f;
}

static float pressureBarFromAdc() {
  float v = readAdcVoltage(g_cfg.adcPin);
  float t = (v - g_cfg.pressureVmin) / (g_cfg.pressureVmax - g_cfg.pressureVmin);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return g_cfg.pressureBarMin + t * (g_cfg.pressureBarMax - g_cfg.pressureBarMin);
}

/** DI: true = OK (HIGH con pull-up = no cableado a masa). Ajustá lógica si tus contactos son NC. */
static bool diOk(int pin) { return digitalRead(pin) == HIGH; }

#if PR500_FEATURE_BLE
/** Sin template: el preprocesador de Arduino 1.8.x rompe `template` en .ino (error «T does not name a type»). */
static void bleNotifyFromDoc(JsonObject obj) {
  if (!gBleCharTx) return;
  String s;
  serializeJson(obj, s);
  s += '\n';
  gBleCharTx->setValue((uint8_t *)s.c_str(), s.length());
  gBleCharTx->notify();
}

static void handleBleLine(const String &line) {
  if (!line.length()) return;
  StaticJsonDocument<384> in;
  if (deserializeJson(in, line)) return;
  const char *op = in["op"] | "";
  if (!strcmp(op, "getParams")) {
    StaticJsonDocument<1024> out;
    out["ok"] = true;
    StaticJsonDocument<896> pr;
    if (LittleFS.exists(PARAMS_PATH)) {
      File f = LittleFS.open(PARAMS_PATH, "r");
      deserializeJson(pr, f);
      f.close();
    } else {
      deserializeJson(pr, DEFAULT_PARAMS_JSON);
    }
    out["params"] = pr.as<JsonObject>();
    bleNotifyFromDoc(out.as<JsonObject>());
    return;
  }
  if (!strcmp(op, "setParams")) {
    JsonObject po = in["params"].as<JsonObject>();
    if (!po) {
      StaticJsonDocument<128> er;
      er["ok"] = false;
      er["error"] = "falta params";
      bleNotifyFromDoc(er.as<JsonObject>());
      return;
    }
    StaticJsonDocument<896> merged;
    if (LittleFS.exists(PARAMS_PATH)) {
      File f = LittleFS.open(PARAMS_PATH, "r");
      deserializeJson(merged, f);
      f.close();
    } else {
      deserializeJson(merged, DEFAULT_PARAMS_JSON);
    }
    for (JsonPair kv : po) merged[kv.key()] = kv.value();
    File fw = LittleFS.open(PARAMS_PATH, "w");
    if (fw) {
      serializeJson(merged, fw);
      fw.close();
    }
    StaticJsonDocument<96> ok;
    ok["ok"] = true;
    bleNotifyFromDoc(ok.as<JsonObject>());
    return;
  }
  if (!strcmp(op, "getConfig")) {
    StaticJsonDocument<768> out;
    out["ok"] = true;
    JsonObject c = out.createNestedObject("config");
    c["api_url"] = g_cfg.apiUrl;
    c["module_id"] = g_cfg.moduleId;
    c["api_key"] = g_cfg.apiKey;
    c["supabase_anon_key"] = g_cfg.supabaseAnonKey;
    c["interval_ms"] = g_cfg.intervalMs;
    c["params_pull_ms"] = g_cfg.paramsPullMs;
    c["wifi_ssid"] = WiFi.SSID();
    c["wifi_connected"] = WiFi.status() == WL_CONNECTED;
    c["ip"] = WiFi.localIP().toString();
    bleNotifyFromDoc(out.as<JsonObject>());
    return;
  }
  if (!strcmp(op, "setConfig")) {
    JsonObject co = in["config"].as<JsonObject>();
    if (!co) {
      StaticJsonDocument<128> er;
      er["ok"] = false;
      er["error"] = "falta config";
      bleNotifyFromDoc(er.as<JsonObject>());
      return;
    }
    if (!ensureLittleFS()) {
      StaticJsonDocument<128> er;
      er["ok"] = false;
      er["error"] = "LittleFS";
      bleNotifyFromDoc(er.as<JsonObject>());
      return;
    }
    StaticJsonDocument<1024> doc;
    if (LittleFS.exists(CFG_PATH)) {
      File fr = LittleFS.open(CFG_PATH, "r");
      if (fr) {
        deserializeJson(doc, fr);
        fr.close();
      }
    }
    if (co.containsKey("api_url")) doc["api_url"] = co["api_url"].as<const char *>();
    if (co.containsKey("module_id")) doc["module_id"] = co["module_id"].as<const char *>();
    if (co.containsKey("api_key")) doc["api_key"] = co["api_key"].as<const char *>();
    if (co.containsKey("supabase_anon_key")) doc["supabase_anon_key"] = co["supabase_anon_key"].as<const char *>();
    if (co.containsKey("interval_ms")) doc["interval_ms"] = co["interval_ms"].as<uint32_t>();
    if (co.containsKey("params_pull_ms")) doc["params_pull_ms"] = co["params_pull_ms"].as<uint32_t>();
    if (!doc.containsKey("adc_pin")) doc["adc_pin"] = PIN_PRESSURE_ADC;
    if (!doc.containsKey("pressure_v_min")) doc["pressure_v_min"] = 0.5;
    if (!doc.containsKey("pressure_v_max")) doc["pressure_v_max"] = 3.0;
    if (!doc.containsKey("pressure_bar_min")) doc["pressure_bar_min"] = 0.0;
    if (!doc.containsKey("pressure_bar_max")) doc["pressure_bar_max"] = 8.0;
    if (!doc.containsKey("ota_check_hours")) doc["ota_check_hours"] = 0;
    if (!doc.containsKey("ota_firmware_url")) doc["ota_firmware_url"] = "";

    File fw = LittleFS.open(CFG_PATH, "w");
    if (!fw) {
      StaticJsonDocument<128> er;
      er["ok"] = false;
      er["error"] = "no pudo guardar config";
      bleNotifyFromDoc(er.as<JsonObject>());
      return;
    }
    serializeJson(doc, fw);
    fw.close();
    loadConfig();

    const char *ssid = in["wifi_ssid"] | "";
    const char *pass = in["wifi_password"] | "";
    if (ssid && strlen(ssid) > 0) {
      WiFi.mode(WIFI_STA);
      WiFi.begin(ssid, pass);
      unsigned long t0 = millis();
      while (WiFi.status() != WL_CONNECTED && (millis() - t0 < 12000UL)) delay(200);
    }

    StaticJsonDocument<256> ok;
    ok["ok"] = true;
    JsonObject c = ok.createNestedObject("config");
    c["wifi_connected"] = WiFi.status() == WL_CONNECTED;
    c["ip"] = WiFi.localIP().toString();
    bleNotifyFromDoc(ok.as<JsonObject>());
    return;
  }
  if (!strcmp(op, "getLive")) {
    StaticJsonDocument<384> out;
    out["ok"] = true;
    out["pressure_bar"] = pressureBarAdjusted();
    out["r1_on"] = digitalRead(PIN_RELAY_C1) == HIGH;
    out["r2_on"] = digitalRead(PIN_RELAY_C2) == HIGH;
    out["r3_on"] = digitalRead(PIN_RELAY_C3) == HIGH;
    out["r4_alarm"] = g_r4Alarm;
    out["di1_ok"] = diOk(PIN_DI1);
    out["di2_ok"] = diOk(PIN_DI2);
    out["di3_ok"] = diOk(PIN_DI3);
    out["di4_ok"] = diOk(PIN_DI4);
    bleNotifyFromDoc(out.as<JsonObject>());
    return;
  }
  StaticJsonDocument<96> er;
  er["ok"] = false;
  er["error"] = "op desconocido";
  bleNotifyFromDoc(er.as<JsonObject>());
}

class BleSrvCallbacks : public BLEServerCallbacks {
public:
  void onDisconnect(BLEServer *) override { BLEDevice::startAdvertising(); }
};
static BleSrvCallbacks gBleSrvCb;

class BleRxCallbacks : public BLECharacteristicCallbacks {
public:
  void onWrite(BLECharacteristic *c) override {
    const String v = c->getValue();
    if (!v.length()) return;
    gBleRxAccum += v;
    for (;;) {
      int nl = gBleRxAccum.indexOf('\n');
      if (nl < 0) break;
      String one = gBleRxAccum.substring(0, nl);
      gBleRxAccum = gBleRxAccum.substring(nl + 1);
      handleBleLine(one);
    }
  }
};
static BleRxCallbacks gBleRxCb;

static void bleSetup() {
  uint64_t mac = ESP.getEfuseMac();
  char bleName[28];
  snprintf(bleName, sizeof(bleName), "PR500-%04X", (unsigned)(mac & 0xffff));
  BLEDevice::init(bleName);
  BLEServer *srv = BLEDevice::createServer();
  srv->setCallbacks(&gBleSrvCb);
  BLEService *svc = srv->createService(PR500_BLE_SERVICE_UUID);
  BLECharacteristic *rx = svc->createCharacteristic(
      PR500_BLE_CHAR_RX_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(&gBleRxCb);
  gBleCharTx = svc->createCharacteristic(PR500_BLE_CHAR_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  gBleCharTx->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(PR500_BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  adv->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.printf("[BLE] Anunciando %s\n", bleName);
}
#else
static void bleSetup() {
  Serial.println(
      F("[BLE] Sin Bluetooth en este firmware (PR500_SMALL_FLASH_BUILD o partición chica). Usá WiFi/nube o subí build con Huge APP."));
}
#endif

static void sendIngest() {
  if (WiFi.status() != WL_CONNECTED) return;

  float pbar = pressureBarAdjusted();
  bool r1 = digitalRead(PIN_RELAY_C1) == HIGH;
  bool r2 = digitalRead(PIN_RELAY_C2) == HIGH;
  bool r3 = digitalRead(PIN_RELAY_C3) == HIGH;
  bool r4alarm = g_r4Alarm;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, g_cfg.apiUrl)) {
    Serial.println(F("[TX] http.begin falló"));
    return;
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(g_cfg.supabaseAnonKey) > 10) {
    http.addHeader("apikey", g_cfg.supabaseAnonKey);
    http.addHeader("Authorization", String("Bearer ") + g_cfg.supabaseAnonKey);
  }

  StaticJsonDocument<512> doc;
  doc["moduleId"] = g_cfg.moduleId;
  doc["deviceToken"] = g_cfg.apiKey;
  doc["pressure_bar"] = pbar;
  doc["r1_on"] = r1;
  doc["r2_on"] = r2;
  doc["r3_on"] = r3;
  doc["r4_alarm"] = r4alarm;
  doc["di1_ok"] = diOk(PIN_DI1);
  doc["di2_ok"] = diOk(PIN_DI2);
  doc["di3_ok"] = diOk(PIN_DI3);
  doc["di4_ok"] = diOk(PIN_DI4);

  time_t now = time(nullptr);
  if (now > 100000) {
    struct tm tmb;
    struct tm *t = gmtime_r(&now, &tmb);
    if (t) {
      char ts[32];
      snprintf(ts, sizeof(ts), "%04d-%02d-%02dT%02d:%02d:%02dZ",
               t->tm_year + 1900, t->tm_mon + 1, t->tm_mday,
               t->tm_hour, t->tm_min, t->tm_sec);
      doc["sentAt"] = ts;
    }
  }

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  Serial.printf("[TX] HTTP %d  P=%.2f bar\n", code, pbar);
  if (code < 0) Serial.println(http.errorToString(code));
  http.end();
}

/** URL de la Edge Function que devuelve params (misma base que ingest-reading). */
static bool buildParamsPullUrl(char *out, size_t outsz) {
  String s(g_cfg.apiUrl);
  const int ix = s.indexOf("ingest-reading");
  if (ix < 0) return false;
  s = s.substring(0, ix) + "fetch-pr500-params";
  if (s.length() <= 0 || (size_t)s.length() >= outsz) return false;
  strlcpy(out, s.c_str(), outsz);
  return true;
}

/** POST a fetch-pr500-params; si `updated_at` cambió, fusiona params en LittleFS (como la app en la nube). */
static void tryFetchPr500ParamsFromCloud(unsigned long nowMs) {
  if (g_cfg.paramsPullMs == 0) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (g_lastParamsCloudPullMs != 0 && (nowMs - g_lastParamsCloudPullMs < g_cfg.paramsPullMs)) return;
  g_lastParamsCloudPullMs = nowMs;

  char url[220];
  if (!buildParamsPullUrl(url, sizeof(url))) {
    Serial.println(F("[PULL] api_url no contiene ingest-reading; no se puede deducir fetch-pr500-params"));
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) {
    Serial.println(F("[PULL] http.begin falló"));
    return;
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(g_cfg.supabaseAnonKey) > 10) {
    http.addHeader("apikey", g_cfg.supabaseAnonKey);
    http.addHeader("Authorization", String("Bearer ") + g_cfg.supabaseAnonKey);
  }
  StaticJsonDocument<192> req;
  req["moduleId"] = g_cfg.moduleId;
  req["deviceToken"] = g_cfg.apiKey;
  String body;
  serializeJson(req, body);
  const int code = http.POST(body);
  if (code != 200) {
    Serial.printf("[PULL] HTTP %d params nube\n", code);
    http.end();
    return;
  }
  const String resp = http.getString();
  http.end();

  StaticJsonDocument<1536> doc;
  const DeserializationError err = deserializeJson(doc, resp);
  if (err || !doc["ok"].as<bool>()) {
    Serial.println(F("[PULL] respuesta JSON inválida"));
    return;
  }
  const char *uat = doc["updated_at"] | "";
  if (!uat[0]) {
    Serial.println(F("[PULL] sin updated_at"));
    return;
  }

  char prev[72]{};
  if (ensureLittleFS() && LittleFS.exists(CLOUD_PARAMS_AT_PATH)) {
    File f = LittleFS.open(CLOUD_PARAMS_AT_PATH, "r");
    if (f) {
      const size_t n = f.readBytes(prev, sizeof(prev) - 1U);
      prev[n] = 0;
      f.close();
      for (char *c = prev; *c; ++c) {
        if (*c == '\r' || *c == '\n') *c = 0;
      }
    }
  }
  if (strcmp(prev, uat) == 0) return;

  JsonObject cloudParams = doc["params"].as<JsonObject>();
  StaticJsonDocument<896> merged;
  if (deserializeJson(merged, DEFAULT_PARAMS_JSON)) {
    Serial.println(F("[PULL] defaults JSON"));
    return;
  }
  if (cloudParams) {
    for (JsonPair kv : cloudParams) merged[kv.key()] = kv.value();
  }
  if (!ensureLittleFS()) return;
  File fw = LittleFS.open(PARAMS_PATH, "w");
  if (!fw) return;
  serializeJson(merged, fw);
  fw.close();

  File fa = LittleFS.open(CLOUD_PARAMS_AT_PATH, "w");
  if (fa) {
    fa.print(uat);
    fa.close();
  }
  Serial.printf("[PULL] Parámetros nube aplicados updated_at=%s\n", uat);
}

static void tryOtaFromUrl(const char *url) {
#if !PR500_FEATURE_OTA_HTTP
  (void)url;
  Serial.println(F("[OTA] Desactivado en este firmware (PR500_SMALL_FLASH_BUILD=1). Actualizá por USB o recompilá con OTA."));
#else
  if (!url || strlen(url) < 12) {
    Serial.println(F("[OTA] URL vacía"));
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[OTA] Sin WiFi"));
    return;
  }
  Serial.printf("[OTA] Descargando: %s\n", url);
  WiFiClientSecure client;
  client.setInsecure();
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return ret = httpUpdate.update(client, url);
  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("[OTA] Fallo: %s\n", httpUpdate.getLastErrorString().c_str());
      break;
    case HTTP_UPDATE_NO_UPDATES:
      Serial.println(F("[OTA] Sin actualización (código 304 / mismo?)"));
      break;
    case HTTP_UPDATE_OK:
      Serial.println(F("[OTA] OK, reinicio…"));
      break;
  }
#endif
}

static void setupWifiPortal() {
  /* Menos cortes al conectar al AP del ESP durante el portal (coexistencia / ahorro de energía). */
  WiFi.setSleep(false);
  /* 0 = el portal no se cierra solo por tiempo (instalación sin display; configurás con calma). */
  wm.setConfigPortalTimeout(0);
  wm.addParameter(&p_api);
  wm.addParameter(&p_mod);
  wm.addParameter(&p_key);
  wm.addParameter(&p_anon);
  wm.addParameter(&p_ota);
  wm.setSaveParamsCallback([]() { saveConfigFromParams(); });

  const bool forcePortal = digitalRead(PIN_FORCE_PORTAL) == LOW;
  if (forcePortal) {
    Serial.println(F("[WiFi] Portal forzado (GPIO14 a GND). Conectate a la WiFi del ESP: PR500-Config (no hace falta internet del modem)."));
    wm.startConfigPortal(AP_NAME);
  } else if (!wm.autoConnect(AP_NAME)) {
    Serial.println(F("[WiFi] Sin credenciales — abriendo portal. WiFi del ESP: PR500-Config (red local; sin internet obligatorio)."));
    wm.startConfigPortal(AP_NAME);
  }

  Serial.print(F("[WiFi] IP "));
  Serial.println(WiFi.localIP());
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
}

void setup() {
  Serial.begin(115200);
  /* USB-UART en Windows a veces pierde los primeros bytes; esperá un poco y forzá salida. */
  delay(800);
#if PR500_FEATURE_OTA_HTTP && PR500_FEATURE_BLE
  Serial.println(F("\nPR500 ESP32 — Supabase ingest + OTA + BLE"));
#elif PR500_FEATURE_OTA_HTTP
  Serial.println(F("\nPR500 ESP32 — Supabase ingest + OTA"));
#elif PR500_FEATURE_BLE
  Serial.println(F("\nPR500 ESP32 — Supabase ingest + BLE"));
#else
  Serial.println(F("\nPR500 ESP32 — Supabase ingest (sin OTA HTTP ni BLE; build reducido)"));
#endif
  Serial.println(F("[BOOT] Serial 115200 baud"));
  Serial.flush();

  setupPins();
  ensureLittleFS();

  /* BLE antes del portal: si el portal bloquea, igual el chip ya anuncia PR500-xxxx (escaneá con nRF Connect o la app). */
  bleSetup();
#if PR500_FEATURE_BLE
  Serial.println(F("[BLE] Ya anunciando; si no lo ves, reiniciá Bluetooth del telefono o usá Chrome Web Bluetooth en la app."));
  Serial.flush();
#endif

  setupWifiPortal();

  if (!loadConfig()) {
    Serial.println(F("[CFG] Falta /config.json — conectate a PR500-Config (red local del ESP; sin limite de tiempo)."));
    wm.startConfigPortal(AP_NAME);
    loadConfig();
  }
  if (!loadConfig()) {
    Serial.println(F("[CFG] Aún sin API: revisá URL, module_id y api_key en el portal"));
  }

  pr500ParamsFromDefaults(&g_pr);
  g_lastPrReloadMs = 0;

  g_lastSend = millis() - g_cfg.intervalMs;

  Serial.println(F("[INIT] Fin setup. Escribi: status (y Enter)"));
  Serial.flush();
}

void loop() {
  unsigned long now = millis();

#if PR500_FEATURE_BLE
  if (gBleCharTx && (now - g_lastBleAdvKickMs > 15000UL)) {
    g_lastBleAdvKickMs = now;
    BLEDevice::startAdvertising();
  }
#endif

  pr500ControlTick(now);

  if (WiFi.status() == WL_CONNECTED) {
    tryFetchPr500ParamsFromCloud(now);

    if (now - g_lastSend >= g_cfg.intervalMs) {
      g_lastSend = now;
      sendIngest();
    }

#if PR500_FEATURE_OTA_HTTP
    if (g_pr.F21 >= 0.5f && g_cfg.otaCheckHours > 0 && strlen(g_cfg.otaFirmwareUrl) > 12) {
      unsigned long period = (unsigned long)g_cfg.otaCheckHours * 3600000UL;
      if (period > 0 && (now - g_lastOtaCheck >= period)) {
        g_lastOtaCheck = now;
        tryOtaFromUrl(g_cfg.otaFirmwareUrl);
      }
    }
#endif
  }

  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    line.toLowerCase();
    if (line == "ota") {
#if PR500_FEATURE_OTA_HTTP
      tryOtaFromUrl(g_cfg.otaFirmwareUrl);
#else
      Serial.println(F("OTA no incluido en este firmware."));
#endif
    } else if (line == "status") {
      Serial.printf("WiFi=%s IP=%s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
      Serial.printf("module=%s interval=%lu ms\n", g_cfg.moduleId, (unsigned long)g_cfg.intervalMs);
      Serial.printf("P=%.2f bar adj (ADC%u) alarm=%d\n", pressureBarAdjusted(), g_cfg.adcPin,
                    g_r4Alarm ? 1 : 0);
      Serial.printf("OTA url len=%u auto_h=%lu\n", (unsigned)strlen(g_cfg.otaFirmwareUrl),
                    (unsigned long)g_cfg.otaCheckHours);
      Serial.printf("params_pull_ms=%lu\n", (unsigned long)g_cfg.paramsPullMs);
    } else if (line == "reboot") {
      ESP.restart();
    } else if (line.length() > 0) {
#if PR500_FEATURE_OTA_HTTP
      Serial.println(F("Comandos: status | ota | reboot"));
#else
      Serial.println(F("Comandos: status | reboot"));
#endif
    }
  }

  delay(50);
}
