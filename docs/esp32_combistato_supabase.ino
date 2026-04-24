/**
 * ESP32 — Combistato (F01–F55) + telemetría HTTPS a Supabase `ingest-reading`.
 *
 * Hardware previsto:
 * - 2× NTC 10k con divisor serie 10k a 3V3 (ADC en el nodo NTC–serie). Pines ADC1.
 * - Relés: compresor, ventilador, deshielo (salida activa en HIGH; F50 invierte compresor).
 * - Entrada puerta (pull-up interno; F26 NA/NC según cableado).
 * - WiFiManager + /config.json (igual que el sketch anterior).
 * - Parámetros combistato en /combistato.json (se crea con defaults si no existe).
 *
 * Telemetría: temp1_c / temp2_c desde NTC; current_a y power_w = 0 (sin pinza).
 *
 * Serial (115200): `help` — modo técnico `tech on|off [min]`, manuales `mcomp`/`mfan`/`mdef`,
 *   prueba de relés `rcomp`/`rfan`/`rdef on|off`, `status`.
 * Modo técnico: la puerta no aplica F40/F28/F29 (verificación); manuales permiten sin F31/F33 si tech activo.
 *
 * F05: 0=resistencia en PIN_RELAY_DEFROST; 1=gas en PIN_RELAY_DEFROST_GAS (si es -1, usa el mismo pin que resistencia).
 *
 * Documentá pines según tu PCB.
 *
 * --- ESP32-WROOM-32 (referencia) ---
 * Para analogRead con WiFi encendido usá canales ADC1: GPIO 32, 33, 34, 35, 36, 39.
 * GPIO 34, 35, 36, 39 son solo entrada (muy aptos para NTC con divisor).
 * GPIO 25/26 son ADC2 si los usás como ADC; como salida digital (relé) no hay problema con WiFi.
 * No uses ADC2 para leer NTC mientras haya WiFi (lecturas inestables o bloqueadas).
 * Evitá strapping crítico al boot: GPIO 0, 2, 12, 15 (y revisá el esquema de tu DevKit).
 * UART USB: GPIO 1 (TX) / 3 (RX) — no ocuparlos con relés.
 * Defaults: 34/35 NTC (ADC1), 33 puerta, 25/26/32 relés (digital), 14 portal config.
 *
 * Placa ESP32 DevKit con ESP-WROOM-32 (como tu diagrama):
 *   Lado izq. (de arriba abajo): EN, 36/VP, 39/VN, 34, 35, 32, 33, 25, 26, 27, 14, 12, 13, GND, VIN
 *   Lado der. (de arriba abajo): 23, 22, 1 TX, 3 RX, 21, 19, 18, 5, 17, 16, 4, 2, 15, GND, 3V3
 * En ese mapa: nuestros NTC usan 34 y 35 (ADC1_6 / ADC1_7); puerta 33 (ADC1_5); relés 25, 26, 32;
 *   portal WiFi forzado en 14 (ADC2_6 en el dibujo — solo como entrada digital, no ADC).
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#define LANG_ES
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <EEPROM.h>
#include <cstring>
#include <ctype.h>
#include <math.h>
#include <time.h>

// ---------- WiFi / Supabase (igual concepto que esp8266 / esp32 monitor) ----------
static const char *CFG_FILE = "/config.json";
static const char *COMBI_FILE = "/combistato.json";
static const unsigned long DEFAULT_INTERVAL_MS = 15000;
static const char *DEFAULT_API_URL =
  "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";
static const char *DEFAULT_SUPABASE_ANON_KEY = "";
static const char *DEFAULT_MODULE_ID = "";
static const char *DEFAULT_API_KEY = "";
static const char *PENDING_FILE = "/pending.jsonl";
static const uint16_t PENDING_MAX_LINES = 120;
static const uint8_t PENDING_FLUSH_MAX_PER_CYCLE = 6;
static const time_t MIN_VALID_EPOCH = 1698796800;
static const unsigned long SERIAL_CONFIG_WINDOW_MS = 2500;

// ---------- Pines — ESP32-WROOM-32 DevKit típico (revisá tu placa) ----------
/** S1 NTC: ADC1_CH6, solo entrada (OK para divisor). */
static const uint8_t PIN_NTC_S1 = 34;
/** S2 NTC: ADC1_CH7, solo entrada. */
static const uint8_t PIN_NTC_S2 = 35;
/** Puerta: GPIO33 = ADC1_CH5; admite INPUT_PULLUP como digital. */
static const int PIN_DOOR = 33;
/** Relés: GPIO25/26/32 son salidas libres en la mayoría de DevKits (no strapping). */
static const int PIN_RELAY_COMP = 25;
static const int PIN_RELAY_FAN = 26;
static const int PIN_RELAY_DEFROST = 32;
/** Si >= 0 y distinto de DEFROST: F05=1 activa este pin; F05=0 activa DEFROST. Si -1, gas usa el mismo relé. */
static const int PIN_RELAY_DEFROST_GAS = -1;
static const int PIN_FORCE_CONFIG = 14;
/** Si no está vacío, `tech on` debe ser `tech on <pin>` (misma cadena). */
static const char TECH_MODE_PIN[] = "";
static const uint16_t TECH_MODE_DEFAULT_MIN = 30;

static const float VCC = 3.3f;
static const float ADC_FS = 4095.0f;
/** Divisor: 3V3 — Rserie — ADC — NTC — GND (NTC 10k @25°C típico). */
static const float NTC_SERIES_OHM = 10000.0f;
static const float NTC_R0_OHM = 10000.0f;
static const float NTC_T0_K = 298.15f;
static const float NTC_BETA = 3950.0f;

static const unsigned long COMBI_TICK_MS = 250;

// ---------- EEPROM config red ----------
struct NvBlob {
  uint32_t magic;
  uint8_t version;
  uint8_t xor8;
  char apiUrl[160];
  char moduleId[48];
  char apiKey[96];
  char intervalMs[16];
} __attribute__((packed));

static const uint32_t NV_MAGIC = 0x324E5653;
static const uint8_t NV_VERSION = 2;

struct AppConfig {
  char apiUrl[160];
  char moduleId[48];
  char apiKey[96];
  char intervalMs[16];
};

AppConfig cfg;
AppConfig g_snap;
unsigned long lastSend = 0;
unsigned long lastCombiMs = 0;
volatile bool g_portalUserSaved = false;
static char g_supabaseAnonKey[512];
static bool g_warnedMissingAnon;
static StaticJsonDocument<768> g_jsonDoc;

WiFiManagerParameter p_module_id("module_id", "ID del modulo", "", 47);
WiFiManagerParameter p_api_key("api_key", "Clave API (6 digitos)", "", 95);
WiFiManagerParameter p_interval("interval", "Intervalo de envio (ms)", "", 15);

static const char WM_CUSTOM_HEAD[] =
  "<meta name=\"theme-color\" content=\"#0b1220\">"
  "<style>:root{--primarycolor:#3b82f6;}body::before{content:\"AR Combistato\";display:block;text-align:center;"
  "font-weight:800;font-size:1.05rem;color:#e8eef7;margin:0 0 0.75rem;}"
  "body{font-family:system-ui,sans-serif;background:#0b1220!important;color:#e8eef7!important;margin:0;padding:0.75rem;}"
  ".wrap{background:#131c2e!important;border-radius:12px!important;padding:1rem!important;max-width:520px!important;margin:auto!important;}"
  "input,button{border-radius:10px!important;padding:0.5rem!important;font-size:1rem!important;}"
  "button{background:#3b82f6!important;color:#fff!important;border:none!important;font-weight:600!important;}"
  "a{color:#60a5fa!important;}</style>";

static void applyWiFiManagerTheme(WiFiManager &wm) {
  wm.setTitle("AR Combistato · Configuracion");
  wm.setCustomHeadElement(WM_CUSTOM_HEAD);
}

static void applyFixedIngestUrl(AppConfig *c) {
  if (!c) return;
  strlcpy(c->apiUrl, DEFAULT_API_URL, sizeof(c->apiUrl));
}

void setDefaults() {
  strlcpy(cfg.apiUrl, DEFAULT_API_URL, sizeof(cfg.apiUrl));
  strlcpy(cfg.moduleId, DEFAULT_MODULE_ID, sizeof(cfg.moduleId));
  strlcpy(cfg.apiKey, DEFAULT_API_KEY, sizeof(cfg.apiKey));
  snprintf(cfg.intervalMs, sizeof(cfg.intervalMs), "%lu", DEFAULT_INTERVAL_MS);
}

void trimCopy(char *dest, size_t destSize, const char *src) {
  if (!src || destSize == 0) {
    if (destSize > 0) dest[0] = '\0';
    return;
  }
  while (*src == ' ' || *src == '\t' || *src == '\r' || *src == '\n') src++;
  strlcpy(dest, src, destSize);
  size_t n = strlen(dest);
  while (n > 0) {
    char c = dest[n - 1];
    if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
    dest[n - 1] = '\0';
    n--;
  }
}

bool mountLittleFs() {
  if (LittleFS.begin()) return true;
  Serial.println(F("[FS] LittleFS no montó; formateando…"));
  yield();
  if (!LittleFS.format()) return false;
  yield();
  return LittleFS.begin();
}

static size_t nvBlobSize() { return sizeof(NvBlob); }

static uint8_t nvXorPayload(const NvBlob *b) {
  uint8_t x = NV_VERSION;
  for (size_t i = 0; i < sizeof(b->apiUrl); i++) x ^= (uint8_t)b->apiUrl[i];
  for (size_t i = 0; i < sizeof(b->moduleId); i++) x ^= (uint8_t)b->moduleId[i];
  for (size_t i = 0; i < sizeof(b->apiKey); i++) x ^= (uint8_t)b->apiKey[i];
  for (size_t i = 0; i < sizeof(b->intervalMs); i++) x ^= (uint8_t)b->intervalMs[i];
  return x;
}

void sanitizePrintable(char *buf, size_t cap) {
  if (cap == 0) return;
  for (size_t i = 0; i < cap - 1; i++) {
    unsigned char c = (unsigned char)buf[i];
    if (c == 0) return;
    if (c < 0x20 || c > 0x7E) {
      buf[i] = '\0';
      return;
    }
  }
  buf[cap - 1] = '\0';
}

void sanitizeAllCfgStrings() {
  sanitizePrintable(cfg.apiUrl, sizeof(cfg.apiUrl));
  sanitizePrintable(cfg.moduleId, sizeof(cfg.moduleId));
  sanitizePrintable(cfg.apiKey, sizeof(cfg.apiKey));
  sanitizePrintable(cfg.intervalMs, sizeof(cfg.intervalMs));
}

static size_t boundedStrLen(const char *s, size_t maxLen) {
  size_t i = 0;
  while (i < maxLen && s[i]) i++;
  return i;
}

static bool looksLikeModuleId(const char *s) {
  size_t n = boundedStrLen(s, sizeof(cfg.moduleId) - 1);
  if (n < 1 || n > 40) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.') continue;
    return false;
  }
  return true;
}

static bool looksLikeApiKey(const char *s) {
  size_t n = boundedStrLen(s, sizeof(cfg.apiKey) - 1);
  if (n < 4) return false;
  if (strncmp(s, "tok_", 4) == 0) {
    for (size_t i = 4; i < n; i++) {
      if (!isxdigit((unsigned char)s[i])) return false;
    }
    return true;
  }
  if (n > 24) return false;
  for (size_t i = 0; i < n; i++) {
    if (!isdigit((unsigned char)s[i])) return false;
  }
  return true;
}

static bool intervalLooksOk(const char *s) {
  size_t n = boundedStrLen(s, sizeof(cfg.intervalMs) - 1);
  if (n == 0) return false;
  for (size_t i = 0; i < n; i++) {
    if (!isdigit((unsigned char)s[i])) return false;
  }
  return true;
}

bool validateLoadedCfg() {
  if (cfg.apiUrl[0] && strncmp(cfg.apiUrl, "http", 4) != 0) return false;
  bool hasMod = cfg.moduleId[0] != '\0';
  bool hasKey = cfg.apiKey[0] != '\0';
  if (hasMod ^ hasKey) return false;
  if (hasMod && !looksLikeModuleId(cfg.moduleId)) return false;
  if (hasKey && !looksLikeApiKey(cfg.apiKey)) return false;
  if (!intervalLooksOk(cfg.intervalMs)) return false;
  return true;
}

void wipeAllStoredConfig() {
  memset(g_supabaseAnonKey, 0, sizeof(g_supabaseAnonKey));
  if (mountLittleFs()) {
    if (LittleFS.exists(CFG_FILE)) LittleFS.remove(CFG_FILE);
    if (LittleFS.exists(PENDING_FILE)) LittleFS.remove(PENDING_FILE);
    if (LittleFS.exists(COMBI_FILE)) LittleFS.remove(COMBI_FILE);
  }
  size_t need = nvBlobSize();
  if (need <= 4096) {
    EEPROM.begin(need);
    for (size_t i = 0; i < need; i++) EEPROM.write(i, 0);
    EEPROM.commit();
  }
}

bool loadConfigEeprom() {
  size_t need = nvBlobSize();
  if (need > 4096) return false;
  EEPROM.begin(need);
  NvBlob b;
  EEPROM.get(0, b);
  if (b.magic != NV_MAGIC || b.version != NV_VERSION) return false;
  if (nvXorPayload(&b) != b.xor8) return false;
  memset(&cfg, 0, sizeof(cfg));
  strlcpy(cfg.apiUrl, DEFAULT_API_URL, sizeof(cfg.apiUrl));
  strlcpy(cfg.moduleId, b.moduleId, sizeof(cfg.moduleId));
  strlcpy(cfg.apiKey, b.apiKey, sizeof(cfg.apiKey));
  strlcpy(cfg.intervalMs, b.intervalMs, sizeof(cfg.intervalMs));
  return true;
}

bool saveConfigEeprom() {
  size_t need = nvBlobSize();
  if (need > 4096) return false;
  EEPROM.begin(need);
  NvBlob b;
  memset(&b, 0, sizeof(b));
  b.magic = NV_MAGIC;
  b.version = NV_VERSION;
  strlcpy(b.apiUrl, cfg.apiUrl, sizeof(b.apiUrl));
  strlcpy(b.moduleId, cfg.moduleId, sizeof(b.moduleId));
  strlcpy(b.apiKey, cfg.apiKey, sizeof(b.apiKey));
  strlcpy(b.intervalMs, cfg.intervalMs, sizeof(b.intervalMs));
  b.xor8 = nvXorPayload(&b);
  EEPROM.put(0, b);
  return EEPROM.commit();
}

bool loadConfigLittleFs() {
  if (!mountLittleFs()) return false;
  if (!LittleFS.exists(CFG_FILE)) return false;
  File f = LittleFS.open(CFG_FILE, "r");
  if (!f) return false;
  g_jsonDoc.clear();
  DeserializationError err = deserializeJson(g_jsonDoc, f);
  f.close();
  if (err) return false;
  strlcpy(cfg.apiUrl, DEFAULT_API_URL, sizeof(cfg.apiUrl));
  strlcpy(cfg.moduleId, g_jsonDoc["moduleId"] | "", sizeof(cfg.moduleId));
  strlcpy(cfg.apiKey, g_jsonDoc["apiKey"] | "", sizeof(cfg.apiKey));
  snprintf(cfg.intervalMs, sizeof(cfg.intervalMs), "%lu",
           (unsigned long)(g_jsonDoc["intervalMs"] | DEFAULT_INTERVAL_MS));
  {
    const char *ak = g_jsonDoc["supabaseAnonKey"] | "";
    if (ak && ak[0]) strlcpy(g_supabaseAnonKey, ak, sizeof(g_supabaseAnonKey));
  }
  return true;
}

void loadConfig() {
  memset(g_supabaseAnonKey, 0, sizeof(g_supabaseAnonKey));
  g_warnedMissingAnon = false;
  setDefaults();
  if (!loadConfigLittleFs() && !loadConfigEeprom()) {
    Serial.println(F("[CFG] Sin config EEPROM/FS válido."));
  } else {
    Serial.println(F("[CFG] config cargado."));
  }
  sanitizeAllCfgStrings();
  if (!validateLoadedCfg()) {
    Serial.println(F("[CFG] Datos corruptos → wipe."));
    wipeAllStoredConfig();
    setDefaults();
  }
  applyFixedIngestUrl(&cfg);
}

bool saveConfigLittleFs() {
  if (!mountLittleFs()) return false;
  File f = LittleFS.open(CFG_FILE, "w");
  if (!f) return false;
  g_jsonDoc.clear();
  g_jsonDoc["apiUrl"] = cfg.apiUrl;
  g_jsonDoc["moduleId"] = cfg.moduleId;
  g_jsonDoc["apiKey"] = cfg.apiKey;
  g_jsonDoc["intervalMs"] = strtoul(cfg.intervalMs, nullptr, 10);
  if (g_supabaseAnonKey[0]) g_jsonDoc["supabaseAnonKey"] = g_supabaseAnonKey;
  size_t n = serializeJson(g_jsonDoc, f);
  f.close();
  return n > 0;
}

bool saveConfig() { return saveConfigLittleFs() || saveConfigEeprom(); }

void onWiFiManagerSave() {
  yield();
  applyFixedIngestUrl(&g_snap);
  trimCopy(g_snap.moduleId, sizeof(g_snap.moduleId), p_module_id.getValue());
  trimCopy(g_snap.apiKey, sizeof(g_snap.apiKey), p_api_key.getValue());
  trimCopy(g_snap.intervalMs, sizeof(g_snap.intervalMs), p_interval.getValue());
  g_portalUserSaved = true;
}

bool pinWantsConfigPortal() {
  pinMode(PIN_FORCE_CONFIG, INPUT_PULLUP);
  delay(30);
  if (digitalRead(PIN_FORCE_CONFIG) != LOW) return false;
  Serial.println(F("[CFG] Mantener 2s pin config -> GND"));
  unsigned long t0 = millis();
  while (digitalRead(PIN_FORCE_CONFIG) == LOW) {
    if (millis() - t0 >= 2000) return true;
    delay(30);
    yield();
  }
  return false;
}

bool serialWantsConfigPortal() {
  unsigned long t0 = millis();
  while (millis() - t0 < SERIAL_CONFIG_WINDOW_MS) {
    if (Serial.available()) {
      String s = Serial.readStringUntil('\n');
      s.trim();
      s.toLowerCase();
      if (s == "config" || s == "portal") return true;
    }
    delay(15);
    yield();
  }
  return false;
}

bool persistAfterPortal() {
  if (g_portalUserSaved) {
    memcpy(&cfg, &g_snap, sizeof(AppConfig));
  } else {
    applyFixedIngestUrl(&cfg);
    trimCopy(cfg.moduleId, sizeof(cfg.moduleId), p_module_id.getValue());
    trimCopy(cfg.apiKey, sizeof(cfg.apiKey), p_api_key.getValue());
    trimCopy(cfg.intervalMs, sizeof(cfg.intervalMs), p_interval.getValue());
  }
  return saveConfig();
}

void setupWiFiAndPortal(bool forceConfigPortal) {
  WiFi.mode(WIFI_STA);
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  wm.setSaveConfigCallback(onWiFiManagerSave);
  applyWiFiManagerTheme(wm);
  g_portalUserSaved = false;
  p_module_id.setValue(cfg.moduleId, sizeof(cfg.moduleId) - 1);
  p_api_key.setValue(cfg.apiKey, sizeof(cfg.apiKey) - 1);
  p_interval.setValue(cfg.intervalMs, sizeof(cfg.intervalMs) - 1);
  wm.addParameter(&p_module_id);
  wm.addParameter(&p_api_key);
  wm.addParameter(&p_interval);
  bool ok = false;
  if (forceConfigPortal) {
    WiFi.disconnect(true);
    delay(300);
    ok = wm.startConfigPortal("SG-ESP-Setup");
    if (!ok) {
      ESP.restart();
      return;
    }
  } else {
    ok = wm.autoConnect("SG-ESP-Setup");
    if (!ok) {
      ESP.restart();
      return;
    }
  }
  delay(500);
  yield();
  char pm[48], pk[96];
  trimCopy(pm, sizeof(pm), p_module_id.getValue());
  trimCopy(pk, sizeof(pk), p_api_key.getValue());
  bool credsChanged = pm[0] && pk[0] && (strcmp(pm, cfg.moduleId) != 0 || strcmp(pk, cfg.apiKey) != 0);
  bool shouldPersist = g_portalUserSaved || forceConfigPortal || credsChanged;
  if (shouldPersist) {
    if (persistAfterPortal()) {
      delay(400);
      ESP.restart();
      return;
    }
  }
  g_portalUserSaved = false;
}

bool configCredentialsOk() { return cfg.moduleId[0] != '\0' && cfg.apiKey[0] != '\0'; }

// ========================= Combistato F01–F55 =========================
struct CombistatoParams {
  float F01_sp;
  float F02_diff;
  float F03_corr_s1;
  float F04_corr_s2;
  uint8_t F05_defrost_type;
  uint16_t F06_defrost_interval_min;
  uint16_t F07_defrost_max_min;
  float F08_defrost_end_evap_c;
  uint8_t F09_defrost_on_boot;
  uint8_t F10_fan_in_defrost;
  uint16_t F11_fan_post_defrost_min;
  float F12_fan_evap_on_below_c;
  float F13_alarm_high;
  float F14_alarm_low;
  uint16_t F15_alarm_delay_min;
  uint8_t F16_probe_alarm;
  float F47_alarm_hyst;
  uint16_t F48_alarm_boot_delay_min;
  uint16_t F17_comp_min_off_s;
  uint16_t F18_comp_min_on_s;
  uint16_t F19_emerg_on_s;
  uint16_t F20_emerg_off_s;
  uint8_t F25_door_enable;
  uint8_t F26_door_nc;
  uint16_t F27_door_alarm_delay_s;
  uint8_t F28_fan_off_door;
  uint8_t F29_block_alarm_door;
  uint8_t F30_log_door;
  uint8_t F40_comp_off_door;
  uint8_t F31_manual_comp;
  uint16_t F32_manual_comp_max_min;
  uint8_t F33_manual_fan;
  uint16_t F34_manual_fan_max_min;
  uint8_t F35_manual_defrost;
  uint16_t F36_manual_defrost_gap_min;
  uint8_t F37_immediate_defrost;
  uint16_t F38_boot_delay_s;
  uint16_t F39_drip_min;
  uint16_t F45_block_defrost_boot_min;
  uint16_t F46_max_no_defrost_min;
  uint8_t F49_heat_mode;
  uint8_t F50_invert_comp_relay;
  uint8_t F51_fan_continuous;
  uint8_t F53_control_probe_s2;
  uint8_t F54_filter_samples;
  uint8_t F55_probe_fault_emergency;
  uint8_t F52_defrost_on_temp_enable;
  float F52_evap_ice_below_c;
} P;

enum CombiPhase : uint8_t { C_BOOT = 0, C_NORMAL, C_DEFROST, C_DRIP };

static CombistatoParams combiDefaults() {
  CombistatoParams d{};
  d.F01_sp = -18.0f;
  d.F02_diff = 3.0f;
  d.F03_corr_s1 = 0;
  d.F04_corr_s2 = 0;
  d.F05_defrost_type = 0;
  d.F06_defrost_interval_min = 360;
  d.F07_defrost_max_min = 30;
  d.F08_defrost_end_evap_c = 8.0f;
  d.F09_defrost_on_boot = 0;
  d.F10_fan_in_defrost = 0;
  d.F11_fan_post_defrost_min = 2;
  d.F12_fan_evap_on_below_c = -5.0f;
  d.F13_alarm_high = 10.0f;
  d.F14_alarm_low = -30.0f;
  d.F15_alarm_delay_min = 5;
  d.F16_probe_alarm = 1;
  d.F47_alarm_hyst = 1.0f;
  d.F48_alarm_boot_delay_min = 5;
  d.F17_comp_min_off_s = 60;
  d.F18_comp_min_on_s = 30;
  d.F19_emerg_on_s = 300;
  d.F20_emerg_off_s = 300;
  d.F25_door_enable = 0;
  d.F26_door_nc = 1;
  d.F27_door_alarm_delay_s = 120;
  d.F28_fan_off_door = 1;
  d.F29_block_alarm_door = 0;
  d.F30_log_door = 0;
  d.F40_comp_off_door = 0;
  d.F31_manual_comp = 0;
  d.F32_manual_comp_max_min = 30;
  d.F33_manual_fan = 0;
  d.F34_manual_fan_max_min = 30;
  d.F35_manual_defrost = 0;
  d.F36_manual_defrost_gap_min = 30;
  d.F37_immediate_defrost = 0;
  d.F38_boot_delay_s = 30;
  d.F39_drip_min = 3;
  d.F45_block_defrost_boot_min = 10;
  d.F46_max_no_defrost_min = 1440;
  d.F49_heat_mode = 0;
  d.F50_invert_comp_relay = 0;
  d.F51_fan_continuous = 0;
  d.F53_control_probe_s2 = 0;
  d.F54_filter_samples = 4;
  d.F55_probe_fault_emergency = 1;
  d.F52_defrost_on_temp_enable = 0;
  d.F52_evap_ice_below_c = -28.0f;
  return d;
}

static void combiParamsToJson(const CombistatoParams &p, JsonObject o) {
  o["F01"] = p.F01_sp;
  o["F02"] = p.F02_diff;
  o["F03"] = p.F03_corr_s1;
  o["F04"] = p.F04_corr_s2;
  o["F05"] = p.F05_defrost_type;
  o["F06"] = p.F06_defrost_interval_min;
  o["F07"] = p.F07_defrost_max_min;
  o["F08"] = p.F08_defrost_end_evap_c;
  o["F09"] = p.F09_defrost_on_boot;
  o["F10"] = p.F10_fan_in_defrost;
  o["F11"] = p.F11_fan_post_defrost_min;
  o["F12"] = p.F12_fan_evap_on_below_c;
  o["F13"] = p.F13_alarm_high;
  o["F14"] = p.F14_alarm_low;
  o["F15"] = p.F15_alarm_delay_min;
  o["F16"] = p.F16_probe_alarm;
  o["F47"] = p.F47_alarm_hyst;
  o["F48"] = p.F48_alarm_boot_delay_min;
  o["F17"] = p.F17_comp_min_off_s;
  o["F18"] = p.F18_comp_min_on_s;
  o["F19"] = p.F19_emerg_on_s;
  o["F20"] = p.F20_emerg_off_s;
  o["F25"] = p.F25_door_enable;
  o["F26"] = p.F26_door_nc;
  o["F27"] = p.F27_door_alarm_delay_s;
  o["F28"] = p.F28_fan_off_door;
  o["F29"] = p.F29_block_alarm_door;
  o["F30"] = p.F30_log_door;
  o["F40"] = p.F40_comp_off_door;
  o["F31"] = p.F31_manual_comp;
  o["F32"] = p.F32_manual_comp_max_min;
  o["F33"] = p.F33_manual_fan;
  o["F34"] = p.F34_manual_fan_max_min;
  o["F35"] = p.F35_manual_defrost;
  o["F36"] = p.F36_manual_defrost_gap_min;
  o["F37"] = p.F37_immediate_defrost;
  o["F38"] = p.F38_boot_delay_s;
  o["F39"] = p.F39_drip_min;
  o["F45"] = p.F45_block_defrost_boot_min;
  o["F46"] = p.F46_max_no_defrost_min;
  o["F49"] = p.F49_heat_mode;
  o["F50"] = p.F50_invert_comp_relay;
  o["F51"] = p.F51_fan_continuous;
  o["F53"] = p.F53_control_probe_s2;
  o["F54"] = p.F54_filter_samples;
  o["F55"] = p.F55_probe_fault_emergency;
  o["F52"] = p.F52_defrost_on_temp_enable;
  o["F52t"] = p.F52_evap_ice_below_c;
}

static void combiJsonToParams(JsonObject o, CombistatoParams *p) {
  if (!p) return;
  *p = combiDefaults();
  if (o.isNull()) return;
  if (o.containsKey("F01")) p->F01_sp = o["F01"].as<float>();
  if (o.containsKey("F02")) p->F02_diff = o["F02"].as<float>();
  if (o.containsKey("F03")) p->F03_corr_s1 = o["F03"].as<float>();
  if (o.containsKey("F04")) p->F04_corr_s2 = o["F04"].as<float>();
  if (o.containsKey("F05")) p->F05_defrost_type = (uint8_t)o["F05"].as<unsigned int>();
  if (o.containsKey("F06")) p->F06_defrost_interval_min = (uint16_t)o["F06"].as<unsigned int>();
  if (o.containsKey("F07")) p->F07_defrost_max_min = (uint16_t)o["F07"].as<unsigned int>();
  if (o.containsKey("F08")) p->F08_defrost_end_evap_c = o["F08"].as<float>();
  if (o.containsKey("F09")) p->F09_defrost_on_boot = (uint8_t)o["F09"].as<unsigned int>();
  if (o.containsKey("F10")) p->F10_fan_in_defrost = (uint8_t)o["F10"].as<unsigned int>();
  if (o.containsKey("F11")) p->F11_fan_post_defrost_min = (uint16_t)o["F11"].as<unsigned int>();
  if (o.containsKey("F12")) p->F12_fan_evap_on_below_c = o["F12"].as<float>();
  if (o.containsKey("F13")) p->F13_alarm_high = o["F13"].as<float>();
  if (o.containsKey("F14")) p->F14_alarm_low = o["F14"].as<float>();
  if (o.containsKey("F15")) p->F15_alarm_delay_min = (uint16_t)o["F15"].as<unsigned int>();
  if (o.containsKey("F16")) p->F16_probe_alarm = (uint8_t)o["F16"].as<unsigned int>();
  if (o.containsKey("F47")) p->F47_alarm_hyst = o["F47"].as<float>();
  if (o.containsKey("F48")) p->F48_alarm_boot_delay_min = (uint16_t)o["F48"].as<unsigned int>();
  if (o.containsKey("F17")) p->F17_comp_min_off_s = (uint16_t)o["F17"].as<unsigned int>();
  if (o.containsKey("F18")) p->F18_comp_min_on_s = (uint16_t)o["F18"].as<unsigned int>();
  if (o.containsKey("F19")) p->F19_emerg_on_s = (uint16_t)o["F19"].as<unsigned int>();
  if (o.containsKey("F20")) p->F20_emerg_off_s = (uint16_t)o["F20"].as<unsigned int>();
  if (o.containsKey("F25")) p->F25_door_enable = (uint8_t)o["F25"].as<unsigned int>();
  if (o.containsKey("F26")) p->F26_door_nc = (uint8_t)o["F26"].as<unsigned int>();
  if (o.containsKey("F27")) p->F27_door_alarm_delay_s = (uint16_t)o["F27"].as<unsigned int>();
  if (o.containsKey("F28")) p->F28_fan_off_door = (uint8_t)o["F28"].as<unsigned int>();
  if (o.containsKey("F29")) p->F29_block_alarm_door = (uint8_t)o["F29"].as<unsigned int>();
  if (o.containsKey("F30")) p->F30_log_door = (uint8_t)o["F30"].as<unsigned int>();
  if (o.containsKey("F40")) p->F40_comp_off_door = (uint8_t)o["F40"].as<unsigned int>();
  if (o.containsKey("F31")) p->F31_manual_comp = (uint8_t)o["F31"].as<unsigned int>();
  if (o.containsKey("F32")) p->F32_manual_comp_max_min = (uint16_t)o["F32"].as<unsigned int>();
  if (o.containsKey("F33")) p->F33_manual_fan = (uint8_t)o["F33"].as<unsigned int>();
  if (o.containsKey("F34")) p->F34_manual_fan_max_min = (uint16_t)o["F34"].as<unsigned int>();
  if (o.containsKey("F35")) p->F35_manual_defrost = (uint8_t)o["F35"].as<unsigned int>();
  if (o.containsKey("F36")) p->F36_manual_defrost_gap_min = (uint16_t)o["F36"].as<unsigned int>();
  if (o.containsKey("F37")) p->F37_immediate_defrost = (uint8_t)o["F37"].as<unsigned int>();
  if (o.containsKey("F38")) p->F38_boot_delay_s = (uint16_t)o["F38"].as<unsigned int>();
  if (o.containsKey("F39")) p->F39_drip_min = (uint16_t)o["F39"].as<unsigned int>();
  if (o.containsKey("F45")) p->F45_block_defrost_boot_min = (uint16_t)o["F45"].as<unsigned int>();
  if (o.containsKey("F46")) p->F46_max_no_defrost_min = (uint16_t)o["F46"].as<unsigned int>();
  if (o.containsKey("F49")) p->F49_heat_mode = (uint8_t)o["F49"].as<unsigned int>();
  if (o.containsKey("F50")) p->F50_invert_comp_relay = (uint8_t)o["F50"].as<unsigned int>();
  if (o.containsKey("F51")) p->F51_fan_continuous = (uint8_t)o["F51"].as<unsigned int>();
  if (o.containsKey("F53")) p->F53_control_probe_s2 = (uint8_t)o["F53"].as<unsigned int>();
  if (o.containsKey("F54")) p->F54_filter_samples = (uint8_t)o["F54"].as<unsigned int>();
  if (o.containsKey("F55")) p->F55_probe_fault_emergency = (uint8_t)o["F55"].as<unsigned int>();
  if (o.containsKey("F52")) p->F52_defrost_on_temp_enable = (uint8_t)o["F52"].as<unsigned int>();
  if (o.containsKey("F52t")) p->F52_evap_ice_below_c = o["F52t"].as<float>();
  if (p->F54_filter_samples < 1) p->F54_filter_samples = 1;
  if (p->F54_filter_samples > 32) p->F54_filter_samples = 32;
}

bool saveCombistatoLittleFs() {
  if (!mountLittleFs()) return false;
  File f = LittleFS.open(COMBI_FILE, "w");
  if (!f) return false;
  DynamicJsonDocument doc(4096);
  JsonObject root = doc.to<JsonObject>();
  combiParamsToJson(P, root);
  bool ok = serializeJson(doc, f) > 0;
  f.close();
  return ok;
}

void loadCombistatoLittleFs() {
  P = combiDefaults();
  if (!mountLittleFs() || !LittleFS.exists(COMBI_FILE)) {
    Serial.println(F("[COMBI] Sin combistato.json → defaults + guardar."));
    saveCombistatoLittleFs();
    return;
  }
  File f = LittleFS.open(COMBI_FILE, "r");
  if (!f) return;
  DynamicJsonDocument doc(4096);
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) {
    Serial.println(F("[COMBI] JSON inválido → defaults."));
    P = combiDefaults();
    saveCombistatoLittleFs();
    return;
  }
  combiJsonToParams(doc.as<JsonObject>(), &P);
  Serial.println(F("[COMBI] combistato.json cargado."));
}

// ---------- Runtime combistato ----------
static CombiPhase g_phase = C_BOOT;
static unsigned long g_phaseSince = 0;
static unsigned long g_bootWallMs = 0;
static bool g_compThermo = false;
static bool g_compRelay = false;
static bool g_fanRelay = false;
static bool g_defRelay = false;
static unsigned long g_lastCompSwitchMs = 0;
static unsigned long g_nextDefrostAt = 0;
static unsigned long g_lastDefrostEndMs = 0;
static unsigned long g_firstDefrostAllowedMs = 0;
static unsigned long g_doorOpenSince = 0;
static bool g_doorOpen = false;
static bool g_probeFault = false;
static bool g_emergHigh = false;
static unsigned long g_emergToggleMs = 0;
static float g_s1_c = NAN, g_s2_c = NAN;
static bool g_alarmHigh = false, g_alarmLow = false;
static unsigned long g_hiAccumMs = 0, g_loAccumMs = 0;

enum ManRelay : uint8_t { MR_AUTO = 0, MR_ON, MR_OFF };
static ManRelay g_manComp = MR_AUTO;
static ManRelay g_manFan = MR_AUTO;
static unsigned long g_manCompUntil = 0;
static unsigned long g_manFanUntil = 0;
static bool g_techMode = false;
static unsigned long g_techUntil = 0;
static unsigned long g_lastManualDefrostMs = 0;
static bool g_doorAlarmLatched = false;
static char g_serialLine[96];
static uint8_t g_serialLineLen = 0;
/** Prueba relé deshielo (`rdef on|off`); si true, writeRelays ignora g_defRelay. */
static bool g_overrideDef = false;
static bool g_overrideDefVal = false;

static void toLowerAscii(char *s) {
  for (; *s; ++s) *s = (char)tolower((unsigned char)*s);
}

static void serialPrintHelp() {
  Serial.println(F("--- AR Combistato (Serial) ---"));
  Serial.println(F("help              Esta ayuda"));
  Serial.println(F("status            Fase, temps, relés, puerta, técnico, manual"));
  Serial.println(F("tech on [min]     Modo técnico: puerta no corta comp/vent (F40/F28/F29)"));
  Serial.println(F("tech off          Fin modo técnico"));
  Serial.println(F("mcomp on|off|auto Manual compresor (F31 o modo técnico); off/auto sin timer"));
  Serial.println(F("mfan on|off|auto  Manual ventilador (F33 o técnico)"));
  Serial.println(F("mdef              Deshielo manual (F35 o técnico; respeta F36/F37)"));
  Serial.println(F("rcomp|rfan|rdef on|off  Fuerza relé SI modo técnico (prueba)"));
}

static void serialPrintStatus() {
  Serial.print(F("[STA] phase="));
  Serial.print((int)g_phase);
  Serial.print(F(" S1="));
  Serial.print(g_s1_c, 2);
  Serial.print(F(" S2="));
  Serial.print(g_s2_c, 2);
  Serial.print(F(" comp="));
  Serial.print(g_compRelay);
  Serial.print(F(" fan="));
  Serial.print(g_fanRelay);
  Serial.print(F(" def="));
  Serial.print(g_defRelay);
  Serial.print(F(" door="));
  Serial.print(g_doorOpen);
  Serial.print(F(" tech="));
  Serial.print(g_techMode);
  Serial.print(F(" mComp="));
  Serial.print((int)g_manComp);
  Serial.print(F(" mFan="));
  Serial.println((int)g_manFan);
}

static bool manualDefrostOk(unsigned long now) {
  if (g_techMode) return true;
  if (!P.F35_manual_defrost) return false;
  if (P.F37_immediate_defrost) return true;
  return (now - g_lastManualDefrostMs) >= (unsigned long)P.F36_manual_defrost_gap_min * 60UL * 1000UL;
}

static void handleSerialLine(char *line) {
  while (*line == ' ' || *line == '\t') line++;
  if (!line[0]) return;
  char buf[96];
  strlcpy(buf, line, sizeof(buf));
  toLowerAscii(buf);
  char *cmd = strtok(buf, " ");
  if (!cmd) return;

  if (!strcmp(cmd, "help") || !strcmp(cmd, "?")) {
    serialPrintHelp();
    return;
  }
  if (!strcmp(cmd, "status")) {
    serialPrintStatus();
    return;
  }

  if (!strcmp(cmd, "tech")) {
    char *a = strtok(nullptr, " ");
    if (!a) {
      Serial.println(F("[TECH] Uso: tech on [min] | tech off [pin si aplica]"));
      return;
    }
    if (!strcmp(a, "off")) {
      g_techMode = false;
      g_manComp = MR_AUTO;
      g_manFan = MR_AUTO;
      g_overrideDef = false;
      Serial.println(F("[TECH] OFF"));
      return;
    }
    if (!strcmp(a, "on")) {
      char *m = strtok(nullptr, " ");
      unsigned mins = TECH_MODE_DEFAULT_MIN;
      const char *pinArg = nullptr;
      if (m) {
        if (isdigit((unsigned char)m[0])) {
          mins = (unsigned)strtoul(m, nullptr, 10);
          if (mins < 1) mins = 1;
          if (mins > 240) mins = 240;
          pinArg = strtok(nullptr, " ");
        } else {
          pinArg = m;
        }
      }
      if (TECH_MODE_PIN[0]) {
        if (!pinArg || strcmp(pinArg, TECH_MODE_PIN) != 0) {
          Serial.println(F("[TECH] PIN incorrecto o falta: tech on [min] <pin>"));
          return;
        }
      }
      g_techMode = true;
      g_techUntil = millis() + mins * 60UL * 1000UL;
      Serial.print(F("[TECH] ON "));
      Serial.print(mins);
      Serial.println(F(" min"));
      return;
    }
    Serial.println(F("[TECH] Uso: tech on [min] [pin] | tech off"));
    return;
  }

  if (!strcmp(cmd, "mcomp")) {
    char *a = strtok(nullptr, " ");
    if (!a) {
      Serial.println(F("[MAN] mcomp on|off|auto"));
      return;
    }
    if (!P.F31_manual_comp && !g_techMode) {
      Serial.println(F("[MAN] F31=0 y sin modo técnico"));
      return;
    }
    if (!strcmp(a, "auto")) {
      g_manComp = MR_AUTO;
      Serial.println(F("[MAN] comp AUTO"));
      return;
    }
    if (!strcmp(a, "on")) {
      g_manComp = MR_ON;
      g_manCompUntil = millis() + (unsigned long)P.F32_manual_comp_max_min * 60UL * 1000UL;
      Serial.println(F("[MAN] comp ON"));
      return;
    }
    if (!strcmp(a, "off")) {
      g_manComp = MR_OFF;
      g_manCompUntil = 0;
      Serial.println(F("[MAN] comp OFF"));
      return;
    }
    return;
  }

  if (!strcmp(cmd, "mfan")) {
    char *a = strtok(nullptr, " ");
    if (!a) {
      Serial.println(F("[MAN] mfan on|off|auto"));
      return;
    }
    if (!P.F33_manual_fan && !g_techMode) {
      Serial.println(F("[MAN] F33=0 y sin modo técnico"));
      return;
    }
    if (!strcmp(a, "auto")) {
      g_manFan = MR_AUTO;
      Serial.println(F("[MAN] fan AUTO"));
      return;
    }
    if (!strcmp(a, "on")) {
      g_manFan = MR_ON;
      g_manFanUntil = millis() + (unsigned long)P.F34_manual_fan_max_min * 60UL * 1000UL;
      Serial.println(F("[MAN] fan ON"));
      return;
    }
    if (!strcmp(a, "off")) {
      g_manFan = MR_OFF;
      g_manFanUntil = 0;
      Serial.println(F("[MAN] fan OFF"));
      return;
    }
    return;
  }

  if (!strcmp(cmd, "mdef")) {
    unsigned long now = millis();
    if (!manualDefrostOk(now)) {
      Serial.println(F("[MAN] deshielo manual no permitido (F35/F36/F37)"));
      return;
    }
    if (g_phase != C_NORMAL) {
      Serial.println(F("[MAN] solo desde fase NORMAL"));
      return;
    }
    g_overrideDef = false;
    g_phase = C_DEFROST;
    g_phaseSince = now;
    g_lastCompSwitchMs = now;
    g_lastManualDefrostMs = now;
    Serial.println(F("[MAN] deshielo iniciado"));
    return;
  }

  if (!strcmp(cmd, "rcomp") || !strcmp(cmd, "rfan") || !strcmp(cmd, "rdef")) {
    if (!g_techMode) {
      Serial.println(F("[REL] activá modo técnico primero: tech on"));
      return;
    }
    char *a = strtok(nullptr, " ");
    if (!strcmp(cmd, "rdef") && a && !strcmp(a, "auto")) {
      g_overrideDef = false;
      Serial.println(F("[REL] def automático (combistato)"));
      return;
    }
    if (!a || (strcmp(a, "on") && strcmp(a, "off"))) {
      Serial.println(F("[REL] rcomp|rfan|rdef on|off | rdef auto"));
      return;
    }
    bool on = !strcmp(a, "on");
    if (!strcmp(cmd, "rcomp")) {
      g_manComp = on ? MR_ON : MR_OFF;
      g_manCompUntil = on ? (millis() + 10UL * 60UL * 1000UL) : 0UL;
      Serial.println(F("[REL] comp prueba"));
    } else if (!strcmp(cmd, "rfan")) {
      g_manFan = on ? MR_ON : MR_OFF;
      g_manFanUntil = on ? (millis() + 10UL * 60UL * 1000UL) : 0UL;
      Serial.println(F("[REL] fan prueba"));
    } else {
      g_overrideDef = true;
      g_overrideDefVal = on;
      Serial.println(F("[REL] def prueba (rdef auto para volver)"));
    }
    return;
  }

  Serial.print(F("[SER] ? "));
  Serial.println(cmd);
}

static void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      g_serialLine[g_serialLineLen] = '\0';
      g_serialLineLen = 0;
      if (g_serialLine[0]) handleSerialLine(g_serialLine);
      continue;
    }
    if (g_serialLineLen < sizeof(g_serialLine) - 1) g_serialLine[g_serialLineLen++] = c;
    else g_serialLineLen = 0;
  }
}

static float ntcRawToC(uint16_t raw) {
  if (raw < 2 || raw > ADC_FS - 2) return NAN;
  float v = (float)raw * (VCC / ADC_FS);
  if (v <= 0.02f || v >= VCC - 0.02f) return NAN;
  float rntc = NTC_SERIES_OHM * v / (VCC - v);
  if (rntc <= 1.0f || rntc > 1.0e7f) return NAN;
  float steinh = logf(rntc / NTC_R0_OHM) / NTC_BETA + 1.0f / NTC_T0_K;
  return 1.0f / steinh - 273.15f;
}

static uint16_t adcAvg(uint8_t pin, uint8_t n) {
  uint32_t acc = 0;
  for (uint8_t i = 0; i < n; i++) {
    acc += analogRead(pin);
    delayMicroseconds(200);
  }
  return (uint16_t)(acc / n);
}

static void readNtcSensors() {
  uint8_t n = P.F54_filter_samples;
  if (n < 1) n = 1;
  g_s1_c = ntcRawToC(adcAvg(PIN_NTC_S1, n)) + P.F03_corr_s1;
  g_s2_c = ntcRawToC(adcAvg(PIN_NTC_S2, n)) + P.F04_corr_s2;
}

static bool doorRawOpen() {
  if (!P.F25_door_enable) return false;
  int v = digitalRead(PIN_DOOR);
  if (P.F26_door_nc) return v == HIGH;
  return v == LOW;
}

static float controlTemp() {
  if (P.F53_control_probe_s2) return g_s2_c;
  return g_s1_c;
}

/** Actualiza g_compThermo (rama histéresis). Frío: ON hasta tc<=SP; OFF hasta tc>=SP+F02. Calor: invertido. */
static void updateThermoHysteresis(float tc) {
  if (isnan(tc)) return;
  if (P.F49_heat_mode) {
    if (g_compThermo) {
      if (tc >= P.F01_sp) g_compThermo = false;
    } else {
      if (tc <= P.F01_sp - P.F02_diff) g_compThermo = true;
    }
  } else {
    if (g_compThermo) {
      if (tc <= P.F01_sp) g_compThermo = false;
    } else {
      if (tc >= P.F01_sp + P.F02_diff) g_compThermo = true;
    }
  }
}

static void applyCompMinTimes(bool desire) {
  unsigned long now = millis();
  if (desire == g_compRelay) return;
  if (desire && !g_compRelay) {
    if (now - g_lastCompSwitchMs >= (unsigned long)P.F17_comp_min_off_s * 1000UL) {
      g_compRelay = true;
      g_lastCompSwitchMs = now;
    }
  } else if (!desire && g_compRelay) {
    if (now - g_lastCompSwitchMs >= (unsigned long)P.F18_comp_min_on_s * 1000UL) {
      g_compRelay = false;
      g_lastCompSwitchMs = now;
    }
  }
}

static void combistatoTick() {
  readNtcSensors();
  bool s1bad = isnan(g_s1_c);
  bool s2bad = isnan(g_s2_c);
  g_probeFault = (P.F53_control_probe_s2 ? s2bad : s1bad) || (s1bad && s2bad);

  unsigned long now = millis();
  if (g_techMode && (long)(now - g_techUntil) >= 0) {
    g_techMode = false;
    g_overrideDef = false;
    Serial.println(F("[TECH] expirado"));
  }
  if (g_manComp == MR_ON && g_manCompUntil != 0 && (long)(now - g_manCompUntil) >= 0) {
    g_manComp = MR_AUTO;
    Serial.println(F("[MAN] comp timer→AUTO"));
  }
  if (g_manFan == MR_ON && g_manFanUntil != 0 && (long)(now - g_manFanUntil) >= 0) {
    g_manFan = MR_AUTO;
    Serial.println(F("[MAN] fan timer→AUTO"));
  }

  bool wasDoor = g_doorOpen;
  bool doorOpen = doorRawOpen();
  if (P.F30_log_door && wasDoor != doorOpen) {
    Serial.print(F("[PUERTA] "));
    Serial.print(doorOpen ? "ABIERTA" : "CERRADA");
    Serial.print(F(" t="));
    Serial.println(now);
  }
  if (doorOpen && !wasDoor) g_doorOpenSince = now;
  g_doorOpen = doorOpen;

  bool doorCtl = P.F25_door_enable && g_doorOpen && !g_techMode;
  if (P.F25_door_enable && g_doorOpen && !g_techMode && P.F27_door_alarm_delay_s > 0) {
    if (now - g_doorOpenSince >= (unsigned long)P.F27_door_alarm_delay_s * 1000UL) {
      if (!g_doorAlarmLatched) {
        g_doorAlarmLatched = true;
        Serial.println(F("[ALM] puerta abierta prolongada (F27)"));
      }
    }
  } else if (!g_doorOpen) {
    g_doorAlarmLatched = false;
  }

  if (g_bootWallMs == 0) g_bootWallMs = now;
  bool bootDone = (now - g_bootWallMs >= (unsigned long)P.F38_boot_delay_s * 1000UL);
  bool alarmBootOk =
    (now - g_bootWallMs >= (unsigned long)P.F48_alarm_boot_delay_min * 60UL * 1000UL);

  float tc = controlTemp();
  if (!g_probeFault) updateThermoHysteresis(tc);

  if (P.F55_probe_fault_emergency && g_probeFault) {
    if (g_emergToggleMs == 0) g_emergToggleMs = now;
    if (g_emergHigh) {
      if (now - g_emergToggleMs >= (unsigned long)P.F19_emerg_on_s * 1000UL) {
        g_emergHigh = false;
        g_emergToggleMs = now;
      }
    } else {
      if (now - g_emergToggleMs >= (unsigned long)P.F20_emerg_off_s * 1000UL) {
        g_emergHigh = true;
        g_emergToggleMs = now;
      }
    }
  } else {
    g_emergHigh = false;
    g_emergToggleMs = 0;
  }

  if (g_phase == C_BOOT) {
    if (bootDone) {
      g_phase = C_NORMAL;
      g_phaseSince = now;
      g_lastDefrostEndMs = now;
      /* bootDone ya cumplió F38; F45 bloquea deshielos programados desde este instante */
      g_firstDefrostAllowedMs = now + (unsigned long)P.F45_block_defrost_boot_min * 60UL * 1000UL;
      g_nextDefrostAt = now + (unsigned long)P.F06_defrost_interval_min * 60UL * 1000UL;
      if (P.F09_defrost_on_boot) {
        g_phase = C_DEFROST;
        g_phaseSince = now;
        g_lastCompSwitchMs = now;
      }
    }
    g_compRelay = false;
    g_defRelay = (g_phase == C_DEFROST);
    g_fanRelay = (P.F10_fan_in_defrost != 0) && (g_phase == C_DEFROST);
    return;
  }

  if (g_phase == C_DEFROST) {
    float evap = g_s2_c;
    bool endTemp = !isnan(evap) && evap >= P.F08_defrost_end_evap_c;
    bool endTime = (now - g_phaseSince) >= (unsigned long)P.F07_defrost_max_min * 60UL * 1000UL;
    if (endTemp || endTime) {
      g_phase = C_DRIP;
      g_phaseSince = now;
      g_defRelay = false;
      g_lastCompSwitchMs = now;
    } else {
      g_defRelay = true;
      g_compRelay = false;
      g_fanRelay = P.F10_fan_in_defrost != 0;
    }
    return;
  }

  if (g_phase == C_DRIP) {
    g_defRelay = false;
    g_compRelay = false;
    g_fanRelay = false;
    if (now - g_phaseSince >= (unsigned long)P.F39_drip_min * 60UL * 1000UL) {
      g_phase = C_NORMAL;
      g_phaseSince = now;
      g_lastDefrostEndMs = now;
      g_nextDefrostAt = now + (unsigned long)P.F06_defrost_interval_min * 60UL * 1000UL;
    }
    return;
  }

  bool forceDefrost = false;
  if (P.F46_max_no_defrost_min > 0 && g_lastDefrostEndMs > 0 &&
      (now - g_lastDefrostEndMs) >= (unsigned long)P.F46_max_no_defrost_min * 60UL * 1000UL) {
    forceDefrost = true;
  }
  if (P.F52_defrost_on_temp_enable && !isnan(g_s2_c) && g_s2_c <= P.F52_evap_ice_below_c &&
      (now - g_lastDefrostEndMs > 120000UL)) {
    forceDefrost = true;
  }
  if (now >= g_nextDefrostAt && P.F06_defrost_interval_min > 0 && now >= g_firstDefrostAllowedMs) {
    forceDefrost = true;
  }

  if (forceDefrost && bootDone) {
    g_phase = C_DEFROST;
    g_phaseSince = now;
    g_lastCompSwitchMs = now;
    return;
  }

  bool compDes = g_compThermo;
  if (P.F55_probe_fault_emergency && g_probeFault) {
    compDes = g_emergHigh;
  }
  if (P.F40_comp_off_door && doorCtl) {
    compDes = false;
  }
  if (!bootDone) compDes = false;

  applyCompMinTimes(compDes);

  bool fanDes = false;
  if (P.F51_fan_continuous) {
    fanDes = true;
  } else {
    bool postDripOk =
      (g_lastDefrostEndMs > 0) &&
      (now - g_lastDefrostEndMs >= (unsigned long)P.F11_fan_post_defrost_min * 60UL * 1000UL);
    if (!postDripOk) {
      fanDes = false;
    } else if (!isnan(g_s2_c)) {
      fanDes = (g_s2_c <= P.F12_fan_evap_on_below_c);
    }
  }
  if (P.F28_fan_off_door && doorCtl) fanDes = false;

  g_fanRelay = fanDes;
  g_defRelay = false;

  if (alarmBootOk && !(P.F29_block_alarm_door && doorCtl) && !isnan(tc)) {
    if (tc >= P.F13_alarm_high) g_hiAccumMs += COMBI_TICK_MS;
    else if (tc <= P.F13_alarm_high - P.F47_alarm_hyst) g_hiAccumMs = 0;
    if (tc <= P.F14_alarm_low) g_loAccumMs += COMBI_TICK_MS;
    else if (tc >= P.F14_alarm_low + P.F47_alarm_hyst) g_loAccumMs = 0;
    unsigned long need = (unsigned long)P.F15_alarm_delay_min * 60UL * 1000UL;
    g_alarmHigh = g_hiAccumMs >= need;
    g_alarmLow = g_loAccumMs >= need;
  }

  if (g_phase == C_NORMAL) {
    bool allowManC = P.F31_manual_comp || g_techMode;
    bool allowManF = P.F33_manual_fan || g_techMode;
    if (g_manComp == MR_ON && allowManC && (g_manCompUntil == 0 || now < g_manCompUntil)) {
      g_compRelay = true;
    } else if (g_manComp == MR_OFF && allowManC) {
      g_compRelay = false;
    }
    if (g_manFan == MR_ON && allowManF && (g_manFanUntil == 0 || now < g_manFanUntil)) {
      g_fanRelay = true;
    } else if (g_manFan == MR_OFF && allowManF) {
      g_fanRelay = false;
    }
  }
}

static void writeRelays() {
  bool c = g_compRelay ^ (P.F50_invert_comp_relay != 0);
  digitalWrite(PIN_RELAY_COMP, c ? HIGH : LOW);
  digitalWrite(PIN_RELAY_FAN, g_fanRelay ? HIGH : LOW);

  bool defOut = g_overrideDef ? g_overrideDefVal : g_defRelay;
  int pinR = PIN_RELAY_DEFROST;
  int pinG = PIN_RELAY_DEFROST_GAS;
  if (pinG < 0) pinG = pinR;
  if (pinG == pinR) {
    digitalWrite(pinR, defOut ? HIGH : LOW);
  } else {
    bool resist = defOut && (P.F05_defrost_type == 0);
    bool gas = defOut && (P.F05_defrost_type == 1);
    digitalWrite(pinR, resist ? HIGH : LOW);
    digitalWrite(pinG, gas ? HIGH : LOW);
  }
}

// ---------- NTP / cola / HTTP ----------
static bool timeLooksValid() { return time(nullptr) > MIN_VALID_EPOCH; }

void syncTimeFromNtp() {
  if (WiFi.status() != WL_CONNECTED) return;
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  for (int i = 0; i < 40; i++) {
    delay(250);
    yield();
    if (timeLooksValid()) return;
  }
}

static unsigned long intervalMsFromCfg() {
  unsigned long interval = strtoul(cfg.intervalMs, nullptr, 10);
  if (interval < 3000) interval = DEFAULT_INTERVAL_MS;
  return interval;
}

static uint16_t countPendingLines() {
  if (!LittleFS.exists(PENDING_FILE)) return 0;
  File f = LittleFS.open(PENDING_FILE, "r");
  if (!f) return 0;
  uint16_t n = 0;
  while (f.available()) {
    if (f.readStringUntil('\n').length()) n++;
  }
  f.close();
  return n;
}

static bool removeFirstPendingLine() {
  File f = LittleFS.open(PENDING_FILE, "r");
  if (!f) return false;
  f.readStringUntil('\n');
  String rest = f.readString();
  f.close();
  if (rest.length() == 0) {
    LittleFS.remove(PENDING_FILE);
    return true;
  }
  f = LittleFS.open(PENDING_FILE, "w");
  if (!f) return false;
  f.print(rest);
  f.close();
  return true;
}

static void appendPendingReading(float t1, float t2, bool hasT2, bool compOn, bool fanOn, bool defOn, bool doorOpen) {
  if (!mountLittleFs()) return;
  StaticJsonDocument<256> doc;
  doc["t1"] = t1;
  if (hasT2 && !isnan(t2)) doc["t2"] = t2;
  else doc["t2"] = static_cast<const char *>(nullptr);
  doc["a"] = 0.0f;
  doc["p"] = 0.0f;
  doc["co"] = compOn ? 1 : 0;
  doc["fa"] = fanOn ? 1 : 0;
  doc["de"] = defOn ? 1 : 0;
  doc["do"] = doorOpen ? 1 : 0;
  String line;
  serializeJson(doc, line);
  File f = LittleFS.open(PENDING_FILE, "a");
  if (f) {
    f.println(line);
    f.close();
  }
}

static bool httpPostIngestBody(const String &body, int *outCode) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  const char *url = (cfg.apiUrl[0] != '\0') ? cfg.apiUrl : DEFAULT_API_URL;
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  const char *anon = g_supabaseAnonKey[0] ? g_supabaseAnonKey
                                          : (DEFAULT_SUPABASE_ANON_KEY[0] ? DEFAULT_SUPABASE_ANON_KEY : nullptr);
  if (anon && anon[0]) {
    http.addHeader("apikey", anon);
    char authHdr[640];
    snprintf(authHdr, sizeof(authHdr), "Bearer %s", anon);
    http.addHeader("Authorization", authHdr);
  } else if (!g_warnedMissingAnon) {
    g_warnedMissingAnon = true;
    Serial.println(F("[HTTP] Falta anon Supabase → posible 401."));
  }
  int code = http.POST(body);
  http.getString();
  http.end();
  if (outCode) *outCode = code;
  return code >= 200 && code < 300;
}

static void flushPendingBacklog() {
  if (WiFi.status() != WL_CONNECTED || !configCredentialsOk()) return;
  if (!timeLooksValid()) {
    syncTimeFromNtp();
    if (!timeLooksValid()) return;
  }
  for (uint8_t k = 0; k < PENDING_FLUSH_MAX_PER_CYCLE; k++) {
    if (!LittleFS.exists(PENDING_FILE)) break;
    uint16_t remaining = countPendingLines();
    if (remaining == 0) break;
    File f = LittleFS.open(PENDING_FILE, "r");
    if (!f) break;
    String line = f.readStringUntil('\n');
    f.close();
    if (line.length() == 0) {
      LittleFS.remove(PENDING_FILE);
      break;
    }
    StaticJsonDocument<256> jd;
    if (deserializeJson(jd, line)) {
      removeFirstPendingLine();
      continue;
    }
    float t1 = jd["t1"].as<float>();
    unsigned long stepSec = intervalMsFromCfg() / 1000UL;
    if (stepSec < 3) stepSec = 15;
    time_t now = time(nullptr);
    time_t sentSec = now - (time_t)(remaining - 1) * (time_t)stepSec;
    if (sentSec < (time_t)MIN_VALID_EPOCH) sentSec = (time_t)MIN_VALID_EPOCH;
    char iso[28];
    struct tm *tm = gmtime(&sentSec);
    if (!tm) break;
    strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", tm);
    g_jsonDoc.clear();
    g_jsonDoc["moduleId"] = cfg.moduleId;
    g_jsonDoc["deviceToken"] = cfg.apiKey;
    g_jsonDoc["sentAt"] = iso;
    g_jsonDoc["temp1_c"] = t1;
    if (jd["t2"].isNull()) g_jsonDoc["temp2_c"] = static_cast<const char *>(nullptr);
    else g_jsonDoc["temp2_c"] = jd["t2"].as<float>();
    g_jsonDoc["temp3_c"] = static_cast<const char *>(nullptr);
    g_jsonDoc["current_a"] = 0.0f;
    g_jsonDoc["power_w"] = 0.0f;
    g_jsonDoc["comp_on"] = jd["co"].as<int>() != 0 ? 1 : 0;
    g_jsonDoc["fan_on"] = jd["fa"].as<int>() != 0 ? 1 : 0;
    g_jsonDoc["defrost_on"] = jd["de"].as<int>() != 0 ? 1 : 0;
    g_jsonDoc["door_open"] = jd["do"].as<int>() != 0 ? 1 : 0;
    String body;
    serializeJson(g_jsonDoc, body);
    if (httpPostIngestBody(body, nullptr)) removeFirstPendingLine();
    else break;
  }
}

void sendTelemetry() {
  if (isnan(g_s1_c)) {
    Serial.println(F("[TMP] S1 inválida"));
    return;
  }
  bool hasT2 = !isnan(g_s2_c);
  if (!configCredentialsOk()) return;
  if (WiFi.status() != WL_CONNECTED) {
    appendPendingReading(g_s1_c, g_s2_c, hasT2, g_compRelay, g_fanRelay, g_defRelay, g_doorOpen);
    return;
  }
  flushPendingBacklog();
  g_jsonDoc.clear();
  g_jsonDoc["moduleId"] = cfg.moduleId;
  g_jsonDoc["deviceToken"] = cfg.apiKey;
  g_jsonDoc["temp1_c"] = g_s1_c;
  if (!hasT2) g_jsonDoc["temp2_c"] = static_cast<const char *>(nullptr);
  else g_jsonDoc["temp2_c"] = g_s2_c;
  g_jsonDoc["temp3_c"] = static_cast<const char *>(nullptr);
  g_jsonDoc["current_a"] = 0.0f;
  g_jsonDoc["power_w"] = 0.0f;
  g_jsonDoc["comp_on"] = g_compRelay ? 1 : 0;
  g_jsonDoc["fan_on"] = g_fanRelay ? 1 : 0;
  g_jsonDoc["defrost_on"] = g_defRelay ? 1 : 0;
  g_jsonDoc["door_open"] = g_doorOpen ? 1 : 0;
  String body;
  serializeJson(g_jsonDoc, body);
  httpPostIngestBody(body, nullptr);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_NTC_S1, ADC_11db);
  analogSetPinAttenuation(PIN_NTC_S2, ADC_11db);

  pinMode(PIN_RELAY_COMP, OUTPUT);
  pinMode(PIN_RELAY_FAN, OUTPUT);
  pinMode(PIN_RELAY_DEFROST, OUTPUT);
  if (PIN_RELAY_DEFROST_GAS >= 0 && PIN_RELAY_DEFROST_GAS != PIN_RELAY_DEFROST) {
    pinMode(PIN_RELAY_DEFROST_GAS, OUTPUT);
    digitalWrite(PIN_RELAY_DEFROST_GAS, LOW);
  }
  pinMode(PIN_DOOR, INPUT_PULLUP);
  digitalWrite(PIN_RELAY_COMP, LOW);
  digitalWrite(PIN_RELAY_FAN, LOW);
  digitalWrite(PIN_RELAY_DEFROST, LOW);

  loadConfig();
  mountLittleFs();
  loadCombistatoLittleFs();

  bool forcePortal = pinWantsConfigPortal() || serialWantsConfigPortal();
  setupWiFiAndPortal(forcePortal);

  if (WiFi.status() == WL_CONNECTED) syncTimeFromNtp();

  g_lastCompSwitchMs = millis();
  Serial.println(F("ESP32 combistato OK"));
  Serial.println(WiFi.localIP());
  Serial.println(F("Serial 115200: escribi help"));
}

void loop() {
  pollSerial();
  unsigned long now = millis();
  if (now - lastCombiMs >= COMBI_TICK_MS) {
    lastCombiMs = now;
    combistatoTick();
    writeRelays();
  }
  unsigned long interval = intervalMsFromCfg();
  if (now - lastSend >= interval) {
    lastSend = now;
    sendTelemetry();
  }
}
