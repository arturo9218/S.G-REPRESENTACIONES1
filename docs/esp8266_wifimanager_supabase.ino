#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <EEPROM.h>
#include <cstring>
#include <ctype.h>
#include <math.h>
#include <time.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// =========================
// Configuración (IMPORTANTE)
// =========================
// cfg.moduleId / cfg.apiKey son lo que se envían al servidor.
// Se guardan en LittleFS (/config.json) y respaldo en EEPROM si el FS falla.
//
// Sin WiFi: las lecturas se encolan en /pending.jsonl (LittleFS) y al reconectar
// se reenvían con sentAt (NTP UTC); las líneas enviadas se borran del archivo.
//
// WiFiManager a veces vacía getValue() al cerrar el portal: por eso en
// setSaveConfigCallback copiamos ya mismo a g_snap (instantánea al pulsar Guardar).
static const char *CFG_FILE = "/config.json";
static const unsigned long DEFAULT_INTERVAL_MS = 15000;
static const char *DEFAULT_API_URL =
  "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";
static const char *DEFAULT_MODULE_ID = "";
static const char *DEFAULT_API_KEY = "";
static const uint8_t PIN_CONSUMO_A0 = A0;
static const uint8_t PIN_TEMP_GPIO2 = 2;
static const int PIN_FORCE_CONFIG = 14;
static const unsigned long SERIAL_CONFIG_WINDOW_MS = 2500;

/** Cola en LittleFS cuando no hay WiFi (líneas JSON compactas). */
static const char *PENDING_FILE = "/pending.jsonl";
static const uint16_t PENDING_MAX_LINES = 120;
static const uint8_t PENDING_FLUSH_MAX_PER_CYCLE = 6;
/** Epoch mínimo razonable (2023-11-01 UTC) para considerar NTP válido. */
static const time_t MIN_VALID_EPOCH = 1698796800;

/**
 * Consumo: SCT-013 60A / 1V (salida AC ya referida, 1 V RMS = 60 A en el primario).
 * Hardware típico: pin A0 con polarización DC al centro (ej. divisor 10k desde 3V3 a GND,
 * nodo central al ADC; señal del SCT por condensador 10µF). Rango útil en NodeMCU: 0–3,3 V en A0.
 *
 * I_rms (A) = V_rms_salida_SCT * (60 / 1). Potencia aparente: P ≈ V_red * I_rms (PF=1; calibrá si hace falta).
 */
static const float SCT013_MAX_PRIMARY_A = 60.0f;
static const float SCT013_OUTPUT_V_RMS_AT_MAX_A = 1.0f;
/** Tensión de red (RMS), ej. 220 o 110 — ajustá a tu instalación. */
static const float MAINS_V_RMS = 220.0f;
/** NodeMCU: analogRead 0–1023 ≈ 0–3,3 V en el pin A0. */
static const float ADC_FULLSCALE_V = 3.3f;
/** Multiplicador fino si comparás con un medidor de referencia (1.0 = sin corrección). */
static const float SCT_POWER_CALIB = 1.0f;
/** Muestras para RMS (~40 ms a 200 µs entre lecturas → varios ciclos a 50 Hz). */
static const int SCT_RMS_SAMPLES = 200;
static const int SCT_SAMPLE_DELAY_US = 200;
/** Por debajo de esto se envía 0 W (ruido del ADC). */
static const float SCT_MIN_WATTS = 8.0f;

/**
 * EEPROM v2: magic + version + XOR del payload (evita leer basura de flash).
 */
struct NvBlob {
  uint32_t magic;
  uint8_t version;
  uint8_t xor8;
  char apiUrl[160];
  char moduleId[48];
  char apiKey[96];
  char intervalMs[16];
} __attribute__((packed));

static const uint32_t NV_MAGIC = 0x324E5653; // SVN2 LE
static const uint8_t NV_VERSION = 2;

struct AppConfig {
  char apiUrl[160];
  char moduleId[48];
  char apiKey[96];
  char intervalMs[16];
};

AppConfig cfg;
/** Valores capturados en el callback de Guardar del portal (crítico). */
AppConfig g_snap;
unsigned long lastSend = 0;
volatile bool g_portalUserSaved = false;

static StaticJsonDocument<512> g_jsonDoc;

OneWire oneWire(PIN_TEMP_GPIO2);
DallasTemperature ds18b20(&oneWire);

WiFiManagerParameter p_api_url("api_url", "API URL", "", 159);
WiFiManagerParameter p_module_id("module_id", "Module ID", "", 47);
WiFiManagerParameter p_api_key("api_key", "API Key (6 digitos)", "", 95);
WiFiManagerParameter p_interval("interval", "Send interval ms", "", 15);

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
  if (!LittleFS.format()) {
    Serial.println(F("[FS] ERROR: LittleFS.format() (revisá FS en Herramientas → Placa)."));
    return false;
  }
  yield();
  if (!LittleFS.begin()) {
    Serial.println(F("[FS] ERROR: begin tras format."));
    return false;
  }
  Serial.println(F("[FS] LittleFS OK."));
  return true;
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

/** Corta en el primer carácter no imprimible (evita basura en Serial / HTTP). */
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

/** 6 dígitos o token legacy tok_… */
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

/** true = cfg coherente (vacío o pareja module+key válidos). */
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
  if (mountLittleFs()) {
    if (LittleFS.exists(CFG_FILE)) {
      LittleFS.remove(CFG_FILE);
      Serial.println(F("[CFG] /config.json eliminado."));
    }
    if (LittleFS.exists(PENDING_FILE)) {
      LittleFS.remove(PENDING_FILE);
      Serial.println(F("[CFG] /pending.jsonl eliminado."));
    }
  }
  size_t need = nvBlobSize();
  if (need <= 4096) {
    EEPROM.begin(need);
    for (size_t i = 0; i < need; i++) EEPROM.write(i, 0);
    EEPROM.commit();
    Serial.println(F("[CFG] EEPROM de config borrada."));
  }
}

bool loadConfigEeprom() {
  size_t need = nvBlobSize();
  if (need > 4096) return false;
  EEPROM.begin(need);
  NvBlob b;
  EEPROM.get(0, b);
  if (b.magic != NV_MAGIC || b.version != NV_VERSION) return false;
  if (nvXorPayload(&b) != b.xor8) {
    Serial.println(F("[EE] EEPROM checksum incorrecto (ignorado)."));
    return false;
  }
  memset(&cfg, 0, sizeof(cfg));
  strlcpy(cfg.apiUrl, b.apiUrl, sizeof(cfg.apiUrl));
  strlcpy(cfg.moduleId, b.moduleId, sizeof(cfg.moduleId));
  strlcpy(cfg.apiKey, b.apiKey, sizeof(cfg.apiKey));
  strlcpy(cfg.intervalMs, b.intervalMs, sizeof(cfg.intervalMs));
  Serial.println(F("[EE] Config leída desde EEPROM (v2)."));
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
  bool ok = EEPROM.commit();
  if (ok) Serial.println(F("[EE] Config guardada en EEPROM."));
  else Serial.println(F("[EE] ERROR: EEPROM.commit falló."));
  return ok;
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
  strlcpy(cfg.apiUrl, g_jsonDoc["apiUrl"] | DEFAULT_API_URL, sizeof(cfg.apiUrl));
  strlcpy(cfg.moduleId, g_jsonDoc["moduleId"] | "", sizeof(cfg.moduleId));
  strlcpy(cfg.apiKey, g_jsonDoc["apiKey"] | "", sizeof(cfg.apiKey));
  snprintf(cfg.intervalMs, sizeof(cfg.intervalMs), "%lu",
           (unsigned long)(g_jsonDoc["intervalMs"] | DEFAULT_INTERVAL_MS));
  return true;
}

/** Imprime solo ASCII seguro (nunca vuelca bytes basura al Serial). */
void safePrintModuleIdLine() {
  Serial.print(F("[CFG] module_id: "));
  const char *v = cfg.moduleId;
  const size_t cap = sizeof(cfg.moduleId);
  for (size_t i = 0; i < cap && v[i]; i++) {
    char c = v[i];
    if (c >= 0x20 && c <= 0x7E) Serial.print(c);
    else {
      Serial.print('?');
      break;
    }
  }
  Serial.println();
}

/** Carga: LittleFS luego EEPROM; sanea y descarta datos corruptos. */
void loadConfig() {
  setDefaults();
  bool fromFs = loadConfigLittleFs();
  if (fromFs) Serial.println(F("[CFG] config.json (LittleFS) cargado."));
  else if (loadConfigEeprom()) {
    // mensaje ya en loadConfigEeprom
  } else {
    Serial.println(F("[CFG] Sin config EEPROM/FS válido."));
  }

  sanitizeAllCfgStrings();

  if (!validateLoadedCfg()) {
    Serial.println(
      F("[CFG] Datos corruptos o incompletos → borrando almacenamiento y usando valores por defecto."));
    wipeAllStoredConfig();
    setDefaults();
  }
}

bool saveConfigLittleFs() {
  if (!mountLittleFs()) return false;
  File f = LittleFS.open(CFG_FILE, "w");
  if (!f) {
    Serial.println(F("[CFG] ERROR: no se puede escribir /config.json."));
    return false;
  }
  g_jsonDoc.clear();
  g_jsonDoc["apiUrl"] = cfg.apiUrl;
  g_jsonDoc["moduleId"] = cfg.moduleId;
  g_jsonDoc["apiKey"] = cfg.apiKey;
  g_jsonDoc["intervalMs"] = strtoul(cfg.intervalMs, nullptr, 10);
  size_t n = serializeJson(g_jsonDoc, f);
  f.flush();
  f.close();
  yield();
  if (n == 0) {
    Serial.println(F("[CFG] ERROR: serializeJson 0."));
    return false;
  }
  Serial.print(F("[CFG] LittleFS OK ("));
  Serial.print(n);
  Serial.println(F(" bytes)."));
  return true;
}

/** Graba en FS y en EEPROM (al menos uno debe OK). */
bool saveConfig() {
  bool fsOk = saveConfigLittleFs();
  bool eeOk = saveConfigEeprom();
  return fsOk || eeOk;
}

/** Callback: copia mínima (sin JSON grande en pila) en el instante del Guardar. */
void onWiFiManagerSave() {
  yield();
  trimCopy(g_snap.apiUrl, sizeof(g_snap.apiUrl), p_api_url.getValue());
  trimCopy(g_snap.moduleId, sizeof(g_snap.moduleId), p_module_id.getValue());
  trimCopy(g_snap.apiKey, sizeof(g_snap.apiKey), p_api_key.getValue());
  trimCopy(g_snap.intervalMs, sizeof(g_snap.intervalMs), p_interval.getValue());
  g_portalUserSaved = true;
  Serial.println(F("[CFG] Callback guardado: snapshot module/api copiado."));
}

bool pinWantsConfigPortal() {
  pinMode(PIN_FORCE_CONFIG, INPUT_PULLUP);
  delay(30);
  if (digitalRead(PIN_FORCE_CONFIG) != LOW) return false;
  Serial.println(F("[CFG] Mantener 2s D5->GND para portal (soltar=cancelar)"));
  unsigned long t0 = millis();
  while (digitalRead(PIN_FORCE_CONFIG) == LOW) {
    if (millis() - t0 >= 2000) return true;
    delay(30);
    yield();
  }
  Serial.println(F("[CFG] Cancelado."));
  return false;
}

bool serialWantsConfigPortal() {
  if (SERIAL_CONFIG_WINDOW_MS == 0) return false;
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
    Serial.println(F("[CFG] Usando snapshot del callback (module_id/api_key)."));
  } else {
    Serial.println(F("[CFG] Sin callback: leyendo getValue()…"));
    trimCopy(cfg.apiUrl, sizeof(cfg.apiUrl), p_api_url.getValue());
    trimCopy(cfg.moduleId, sizeof(cfg.moduleId), p_module_id.getValue());
    trimCopy(cfg.apiKey, sizeof(cfg.apiKey), p_api_key.getValue());
    trimCopy(cfg.intervalMs, sizeof(cfg.intervalMs), p_interval.getValue());
  }
  Serial.print(F("[CFG] module_id len="));
  Serial.println(strlen(cfg.moduleId));
  Serial.print(F("[CFG] api_key len="));
  Serial.println(strlen(cfg.apiKey));
  if (!saveConfig()) {
    delay(300);
    yield();
    return saveConfig();
  }
  return true;
}

void setupWiFiAndPortal(bool forceConfigPortal) {
  WiFi.mode(WIFI_STA);
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  wm.setSaveConfigCallback(onWiFiManagerSave);
  g_portalUserSaved = false;

  p_api_url.setValue(cfg.apiUrl, sizeof(cfg.apiUrl) - 1);
  p_module_id.setValue(cfg.moduleId, sizeof(cfg.moduleId) - 1);
  p_api_key.setValue(cfg.apiKey, sizeof(cfg.apiKey) - 1);
  p_interval.setValue(cfg.intervalMs, sizeof(cfg.intervalMs) - 1);

  wm.addParameter(&p_api_url);
  wm.addParameter(&p_module_id);
  wm.addParameter(&p_api_key);
  wm.addParameter(&p_interval);

  bool ok = false;
  if (forceConfigPortal) {
    Serial.println(F("[CFG] Red SG-ESP-Setup → http://192.168.4.1"));
    WiFi.disconnect(true);
    delay(300);
    ok = wm.startConfigPortal("SG-ESP-Setup");
    if (!ok) {
      Serial.println(F("[CFG] Portal sin WiFi. Reinicio."));
      delay(500);
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

  // Dar tiempo a que WM termine de volcar el formulario
  delay(500);
  yield();

  char pm[48], pk[96];
  trimCopy(pm, sizeof(pm), p_module_id.getValue());
  trimCopy(pk, sizeof(pk), p_api_key.getValue());
  bool credsChanged =
    pm[0] && pk[0] && (strcmp(pm, cfg.moduleId) != 0 || strcmp(pk, cfg.apiKey) != 0);

  bool shouldPersist = g_portalUserSaved || forceConfigPortal || credsChanged;

  if (shouldPersist) {
    if (persistAfterPortal()) {
      delay(400);
      Serial.println(F("[CFG] Reinicio…"));
      ESP.restart();
      return;
    }
    Serial.println(F("[CFG] ERROR: no se pudo guardar (FS+EEPROM)."));
  }
  g_portalUserSaved = false;
}

bool configCredentialsOk() {
  return cfg.moduleId[0] != '\0' && cfg.apiKey[0] != '\0';
}

void readTemps12(float *out1, float *out2) {
  ds18b20.requestTemperatures();
  float a = ds18b20.getTempCByIndex(0);
  *out1 = (a == DEVICE_DISCONNECTED_C) ? NAN : a;
  float b = ds18b20.getTempCByIndex(1);
  *out2 = (b == DEVICE_DISCONNECTED_C) ? NAN : b;
}

/** Corriente RMS (A) en el conductor; potencia = MAINS_V_RMS * I (con calibración). */
float readSctAmpsRms() {
  static uint16_t buf[SCT_RMS_SAMPLES];
  long sum = 0;
  for (int i = 0; i < SCT_RMS_SAMPLES; i++) {
    buf[i] = analogRead(PIN_CONSUMO_A0);
    sum += (long)buf[i];
    delayMicroseconds(SCT_SAMPLE_DELAY_US);
    yield();
  }
  float mean = (float)sum / (float)SCT_RMS_SAMPLES;
  double acc = 0.0;
  for (int i = 0; i < SCT_RMS_SAMPLES; i++) {
    double d = (double)buf[i] - (double)mean;
    acc += d * d;
  }
  float rms_adc = sqrtf((float)(acc / (double)SCT_RMS_SAMPLES));
  float v_rms = (rms_adc / 1023.0f) * ADC_FULLSCALE_V;
  float amps_from_sct = v_rms * (SCT013_MAX_PRIMARY_A / SCT013_OUTPUT_V_RMS_AT_MAX_A);
  float amps = amps_from_sct * SCT_POWER_CALIB;
  float watts = MAINS_V_RMS * amps;
  if (watts < SCT_MIN_WATTS) return 0.0f;
  return amps;
}

static unsigned long intervalMsFromCfg() {
  unsigned long interval = strtoul(cfg.intervalMs, nullptr, 10);
  if (interval < 3000) interval = DEFAULT_INTERVAL_MS;
  return interval;
}

static bool timeLooksValid() {
  time_t t = time(nullptr);
  return t > MIN_VALID_EPOCH;
}

/** Tras conectar WiFi: hora UTC para sentAt en la cola (ingest-reading usa sentAt → created_at). */
void syncTimeFromNtp() {
  if (WiFi.status() != WL_CONNECTED) return;
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  for (int i = 0; i < 40; i++) {
    delay(250);
    yield();
    if (timeLooksValid()) {
      Serial.println(F("[NTP] Hora sincronizada (UTC)."));
      return;
    }
  }
  Serial.println(F("[NTP] Sin hora aún; la cola esperará NTP para reenviar."));
}

static uint16_t countPendingLines() {
  if (!LittleFS.exists(PENDING_FILE)) return 0;
  File f = LittleFS.open(PENDING_FILE, "r");
  if (!f) return 0;
  uint16_t n = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    if (line.length()) n++;
  }
  f.close();
  return n;
}

static void trimOldestPendingLines(uint16_t drop) {
  if (drop == 0) return;
  File f = LittleFS.open(PENDING_FILE, "r");
  if (!f) return;
  for (uint16_t i = 0; i < drop; i++) {
    while (f.available()) {
      char c = (char)f.read();
      if (c == '\n') break;
    }
  }
  String rest = f.readString();
  f.close();
  f = LittleFS.open(PENDING_FILE, "w");
  if (!f) return;
  f.print(rest);
  f.close();
  Serial.print(F("[Q] descartadas líneas antiguas: "));
  Serial.println(drop);
}

static void trimPendingIfNeeded() {
  uint16_t n = countPendingLines();
  if (n <= PENDING_MAX_LINES) return;
  uint16_t drop = (uint16_t)(n - (PENDING_MAX_LINES - 20));
  trimOldestPendingLines(drop);
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

/** Guarda una lectura cuando no hay WiFi (JSON compacto por línea). */
static void appendPendingReading(float t1, float t2, bool hasT2, float amps, float p) {
  if (!mountLittleFs()) return;
  trimPendingIfNeeded();
  StaticJsonDocument<192> doc;
  doc["t1"] = t1;
  if (hasT2 && !isnan(t2)) {
    doc["t2"] = t2;
  } else {
    doc["t2"] = static_cast<const char *>(nullptr);
  }
  doc["a"] = amps;
  doc["p"] = p;
  doc["m"] = millis();
  String line;
  serializeJson(doc, line);
  File f = LittleFS.open(PENDING_FILE, "a");
  if (!f) {
    Serial.println(F("[Q] ERROR: no se puede abrir pending (append)."));
    return;
  }
  f.println(line);
  f.close();
  Serial.print(F("[Q] Sin WiFi: guardado en cola ("));
  Serial.print(countPendingLines());
  Serial.println(F(" líneas)"));
}

static bool httpPostIngestBody(const String &body, int *outCode) {
  std::unique_ptr<BearSSL::WiFiClientSecure> secure(new BearSSL::WiFiClientSecure);
  secure->setInsecure();
  HTTPClient http;
  if (!http.begin(*secure, cfg.apiUrl)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  Serial.print(F("[HTTP] code="));
  Serial.print(code);
  Serial.print(F(" resp="));
  Serial.println(resp);
  if (outCode) *outCode = code;
  return code >= 200 && code < 300;
}

/** Envía líneas antiguas con sentAt estimado (espaciado = intervalo de muestreo). */
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
    DeserializationError err = deserializeJson(jd, line);
    if (err) {
      Serial.println(F("[Q] línea corrupta → se descarta"));
      removeFirstPendingLine();
      continue;
    }

    if (!jd.containsKey("t1")) {
      removeFirstPendingLine();
      continue;
    }
    float t1 = jd["t1"].as<float>();

    unsigned long intervalMs = intervalMsFromCfg();
    unsigned long stepSec = intervalMs / 1000UL;
    if (stepSec < 3) stepSec = 15;

    time_t now = time(nullptr);
    time_t sentSec = now - (time_t)(remaining - 1) * (time_t)stepSec;
    if (sentSec < (time_t)MIN_VALID_EPOCH) {
      sentSec = (time_t)MIN_VALID_EPOCH;
    }
    char iso[28];
    struct tm *tm = gmtime(&sentSec);
    if (!tm) {
      break;
    }
    strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", tm);

    g_jsonDoc.clear();
    g_jsonDoc["moduleId"] = cfg.moduleId;
    g_jsonDoc["deviceToken"] = cfg.apiKey;
    g_jsonDoc["sentAt"] = iso;
    g_jsonDoc["temp1_c"] = t1;
    if (jd["t2"].isNull()) {
      g_jsonDoc["temp2_c"] = static_cast<const char *>(nullptr);
    } else {
      g_jsonDoc["temp2_c"] = jd["t2"].as<float>();
    }
    g_jsonDoc["temp3_c"] = static_cast<const char *>(nullptr);
    g_jsonDoc["current_a"] = jd["a"] | 0.0f;
    g_jsonDoc["power_w"] = jd["p"] | 0.0f;

    String body;
    serializeJson(g_jsonDoc, body);
    if (httpPostIngestBody(body, nullptr)) {
      removeFirstPendingLine();
      Serial.print(F("[Q] Reenviada cola, restan ~"));
      Serial.println(countPendingLines());
    } else {
      Serial.println(F("[Q] Fallo HTTP; se reintenta en el próximo ciclo."));
      break;
    }
  }
}

void sendTelemetry() {
  float t1 = NAN, t2 = NAN;
  readTemps12(&t1, &t2);
  float amps = readSctAmpsRms();
  float p = MAINS_V_RMS * amps;

  if (isnan(t1)) {
    Serial.println(F("[TMP] Sensor 1 desconectado (GPIO2)"));
    return;
  }

  bool hasT2 = !isnan(t2);

  if (!configCredentialsOk()) {
    static bool warned = false;
    if (!warned) {
      Serial.println(F("[HTTP] Falta module_id o api_key."));
      warned = true;
    }
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    appendPendingReading(t1, t2, hasT2, amps, p);
    return;
  }

  flushPendingBacklog();

  g_jsonDoc.clear();
  g_jsonDoc["moduleId"] = cfg.moduleId;
  g_jsonDoc["deviceToken"] = cfg.apiKey;
  g_jsonDoc["temp1_c"] = t1;
  if (!hasT2) {
    g_jsonDoc["temp2_c"] = static_cast<const char *>(nullptr);
  } else {
    g_jsonDoc["temp2_c"] = t2;
  }
  g_jsonDoc["temp3_c"] = static_cast<const char *>(nullptr);
  g_jsonDoc["current_a"] = amps;
  g_jsonDoc["power_w"] = p;

  String body;
  serializeJson(g_jsonDoc, body);
  httpPostIngestBody(body, nullptr);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  loadConfig();

  bool forcePortal = pinWantsConfigPortal();
  if (!forcePortal) forcePortal = serialWantsConfigPortal();
  if (forcePortal) Serial.println(F("[CFG] Portal forzado (API/module/key)."));

  setupWiFiAndPortal(forcePortal);
  ds18b20.begin();

  if (WiFi.status() == WL_CONNECTED) {
    syncTimeFromNtp();
  }

  Serial.println(F("WiFi OK"));
  Serial.print(F("IP: "));
  Serial.println(WiFi.localIP());
  if (configCredentialsOk()) {
    safePrintModuleIdLine();
  } else {
    Serial.println(F("[CFG] Vacío: portal con D5->GND 2s al reset."));
  }
}

void loop() {
  unsigned long now = millis();
  unsigned long interval = strtoul(cfg.intervalMs, nullptr, 10);
  if (interval < 3000) interval = DEFAULT_INTERVAL_MS;
  if (now - lastSend >= interval) {
    lastSend = now;
    sendTelemetry();
  }
}
