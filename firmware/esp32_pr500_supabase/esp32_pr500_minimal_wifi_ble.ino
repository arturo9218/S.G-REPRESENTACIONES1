/**
 * ESP32 PR500 - MINIMAL WIFI + BLE + INGEST
 *
 * Objetivo: probar solo conectividad (WiFi + app/nube), sin lógica de relés.
 *
 * - WiFiManager solo para SSID/clave (portal PR500-Setup).
 * - BLE para provisionar module_id y api_key desde la app.
 * - Envío periódico a ingest-reading para marcar online en dashboard.
 *
 * Placa recomendada: ESP32 Dev Module
 * Partición: Huge APP (si usás BLE)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ===== Ajustes base =====
static const char *CFG_PATH = "/config.json";
static const char *AP_NAME = "PR500-Setup";
static const int PIN_FORCE_PORTAL = 14;  // GND al arrancar -> forzar portal
static const uint32_t DEFAULT_SEND_MS = 15000;
static const char *DEFAULT_INGEST_URL =
    "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";

// ===== UUID BLE (mismos que app) =====
#define PR500_BLE_SERVICE_UUID "12345678-1234-1234-1234-123456789001"
#define PR500_BLE_CHAR_RX_UUID "12345678-1234-1234-1234-123456789002"
#define PR500_BLE_CHAR_TX_UUID "12345678-1234-1234-1234-123456789003"

struct Cfg {
  char moduleId[48]{};
  char apiKey[24]{};
  char anonKey[400]{};
  uint32_t intervalMs = DEFAULT_SEND_MS;
};

static Cfg g_cfg;
static bool g_fsOk = false;
static unsigned long g_lastSendMs = 0;
static unsigned long g_lastWifiRetryMs = 0;

static BLECharacteristic *gTx = nullptr;
static String gBleBuf;

static void trimAsciiInPlace(char *s) {
  if (!s) return;
  size_t n = strlen(s);
  size_t i = 0;
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
  Serial.println(F("[FS] mount fail, format..."));
  if (!LittleFS.format()) return false;
  if (!LittleFS.begin(false)) return false;
  g_fsOk = true;
  return true;
}

static bool loadConfig() {
  memset(&g_cfg, 0, sizeof(g_cfg));
  g_cfg.intervalMs = DEFAULT_SEND_MS;
  if (!ensureFs()) return false;
  if (!LittleFS.exists(CFG_PATH)) return false;

  File f = LittleFS.open(CFG_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<1024> doc;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) return false;

  strlcpy(g_cfg.moduleId, doc["module_id"] | "", sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey, doc["api_key"] | "", sizeof(g_cfg.apiKey));
  strlcpy(g_cfg.anonKey, doc["supabase_anon_key"] | "", sizeof(g_cfg.anonKey));
  g_cfg.intervalMs = (uint32_t)(doc["interval_ms"] | DEFAULT_SEND_MS);
  if (g_cfg.intervalMs < 5000) g_cfg.intervalMs = 5000;
  trimAsciiInPlace(g_cfg.moduleId);
  trimAsciiInPlace(g_cfg.apiKey);
  trimAsciiInPlace(g_cfg.anonKey);
  return true;
}

static bool saveConfig() {
  if (!ensureFs()) return false;
  StaticJsonDocument<1024> doc;
  doc["api_url"] = DEFAULT_INGEST_URL;
  doc["module_id"] = g_cfg.moduleId;
  doc["api_key"] = g_cfg.apiKey;
  doc["supabase_anon_key"] = g_cfg.anonKey;
  doc["interval_ms"] = g_cfg.intervalMs;
  File f = LittleFS.open(CFG_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  return true;
}

static void notifyJson(StaticJsonDocument<512> &doc) {
  if (!gTx) return;
  String s;
  serializeJson(doc, s);
  s += '\n';
  gTx->setValue((uint8_t *)s.c_str(), s.length());
  gTx->notify();
}

class RxCallbacks : public BLECharacteristicCallbacks {
public:
  void onWrite(BLECharacteristic *c) override {
    String chunk = c->getValue();
    if (!chunk.length()) return;
    gBleBuf += chunk;
    for (;;) {
      int nl = gBleBuf.indexOf('\n');
      if (nl < 0) break;
      String line = gBleBuf.substring(0, nl);
      gBleBuf = gBleBuf.substring(nl + 1);
      line.trim();
      if (!line.length()) continue;

      StaticJsonDocument<512> in;
      if (deserializeJson(in, line)) continue;
      const char *op = in["op"] | "";

      if (!strcmp(op, "getConfig")) {
        StaticJsonDocument<512> out;
        out["ok"] = true;
        JsonObject cfg = out.createNestedObject("config");
        cfg["api_url"] = DEFAULT_INGEST_URL;
        cfg["module_id"] = g_cfg.moduleId;
        cfg["api_key"] = g_cfg.apiKey;
        cfg["supabase_anon_key"] = g_cfg.anonKey;
        cfg["interval_ms"] = g_cfg.intervalMs;
        cfg["wifi_ssid"] = WiFi.SSID();
        cfg["wifi_connected"] = WiFi.status() == WL_CONNECTED;
        cfg["ip"] = WiFi.localIP().toString();
        notifyJson(out);
      } else if (!strcmp(op, "setConfig")) {
        JsonObject cfgIn = in["config"].as<JsonObject>();
        if (cfgIn) {
          if (cfgIn.containsKey("module_id")) strlcpy(g_cfg.moduleId, cfgIn["module_id"] | "", sizeof(g_cfg.moduleId));
          if (cfgIn.containsKey("api_key")) strlcpy(g_cfg.apiKey, cfgIn["api_key"] | "", sizeof(g_cfg.apiKey));
          if (cfgIn.containsKey("supabase_anon_key"))
            strlcpy(g_cfg.anonKey, cfgIn["supabase_anon_key"] | "", sizeof(g_cfg.anonKey));
          if (cfgIn.containsKey("interval_ms")) g_cfg.intervalMs = cfgIn["interval_ms"].as<uint32_t>();
          if (g_cfg.intervalMs < 5000) g_cfg.intervalMs = 5000;
          trimAsciiInPlace(g_cfg.moduleId);
          trimAsciiInPlace(g_cfg.apiKey);
          trimAsciiInPlace(g_cfg.anonKey);
          saveConfig();
        }

        const char *ssid = in["wifi_ssid"] | "";
        const char *pass = in["wifi_password"] | "";
        if (ssid && strlen(ssid) > 0) {
          WiFi.disconnect(true, true);
          delay(200);
          WiFi.mode(WIFI_STA);
          WiFi.begin(ssid, pass);
          unsigned long t0 = millis();
          while (WiFi.status() != WL_CONNECTED && (millis() - t0 < 12000UL)) delay(200);
        }

        StaticJsonDocument<512> out;
        out["ok"] = true;
        JsonObject cfg = out.createNestedObject("config");
        cfg["wifi_connected"] = WiFi.status() == WL_CONNECTED;
        cfg["ip"] = WiFi.localIP().toString();
        notifyJson(out);
      }
    }
  }
};

static RxCallbacks gRxCb;

static void setupBle() {
  uint64_t mac = ESP.getEfuseMac();
  char name[28];
  snprintf(name, sizeof(name), "PR500-%04X", (unsigned)(mac & 0xffff));
  BLEDevice::init(name);
  BLEServer *srv = BLEDevice::createServer();
  BLEService *svc = srv->createService(PR500_BLE_SERVICE_UUID);
  BLECharacteristic *rx = svc->createCharacteristic(PR500_BLE_CHAR_RX_UUID,
                                                     BLECharacteristic::PROPERTY_WRITE |
                                                         BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(&gRxCb);
  gTx = svc->createCharacteristic(PR500_BLE_CHAR_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  gTx->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(PR500_BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("[BLE] Anunciando %s\n", name);
}

static void setupWifiPortal() {
  WiFi.setSleep(false);
  WiFi.persistent(false);
  wm.setConnectTimeout(15);
  wm.setConfigPortalTimeout(0);

  bool forcePortal = digitalRead(PIN_FORCE_PORTAL) == LOW;
  if (forcePortal) {
    WiFi.disconnect(true, true);
    delay(200);
    wm.startConfigPortal(AP_NAME);
  } else if (!wm.autoConnect(AP_NAME)) {
    WiFi.disconnect(true, true);
    delay(200);
    wm.startConfigPortal(AP_NAME);
  }
  Serial.printf("[WiFi] SSID=%s IP=%s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
}

static void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (g_lastWifiRetryMs != 0 && now - g_lastWifiRetryMs < 10000UL) return;
  g_lastWifiRetryMs = now;
  if (!WiFi.SSID().length()) return;
  WiFi.reconnect();
}

static void sendIngestPing() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!strlen(g_cfg.moduleId) || !strlen(g_cfg.apiKey)) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, DEFAULT_INGEST_URL)) return;
  http.addHeader("Content-Type", "application/json");
  if (strlen(g_cfg.anonKey) > 10) {
    http.addHeader("apikey", g_cfg.anonKey);
    http.addHeader("Authorization", String("Bearer ") + g_cfg.anonKey);
  }

  StaticJsonDocument<256> body;
  body["moduleId"] = g_cfg.moduleId;
  body["deviceToken"] = g_cfg.apiKey;
  body["pressure_bar"] = 0.0f;
  body["r1_on"] = false;
  body["r2_on"] = false;
  body["r3_on"] = false;
  body["r4_alarm"] = false;
  String payload;
  serializeJson(body, payload);

  int code = http.POST(payload);
  if (code < 0) {
    delay(120);
    code = http.POST(payload);
  }
  Serial.printf("[TX] HTTP %d\n", code);
  if (code < 0) Serial.printf("[TX] err=%s\n", http.errorToString(code).c_str());
  http.end();
}

void setup() {
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
  Serial.begin(115200);
  delay(250);
  Serial.println(F("\nPR500 MINIMAL WIFI+BLE"));

  ensureFs();
  loadConfig();
  setupBle();
  setupWifiPortal();

  g_lastSendMs = millis() - g_cfg.intervalMs;
  Serial.println(F("[INIT] listo. comandos: status | reboot"));
}

void loop() {
  maintainWifi();
  unsigned long now = millis();
  if (now - g_lastSendMs >= g_cfg.intervalMs) {
    g_lastSendMs = now;
    sendIngestPing();
  }

  if (Serial.available()) {
    String s = Serial.readStringUntil('\n');
    s.trim();
    s.toLowerCase();
    if (s == "status") {
      Serial.printf("WiFi.status=%d SSID=%s IP=%s RSSI=%d\n", (int)WiFi.status(), WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
      Serial.printf("module_id=%s api_key_len=%u interval_ms=%lu\n", g_cfg.moduleId, (unsigned)strlen(g_cfg.apiKey),
                    (unsigned long)g_cfg.intervalMs);
    } else if (s == "reboot") {
      ESP.restart();
    }
  }

  delay(30);
}

