/**
 * ESP32 PR500 TEST - WiFiManager + lectura presión + control relés.
 *
 * Fase de pruebas (sin BLE, sin nube):
 * - Portal WiFiManager estable.
 * - Lectura de sensor de presión por ADC.
 * - Control local de 3 relés por histéresis (estilo PR500).
 */

#include <WiFi.h>
#include <WiFiManager.h>

static const char *AP_NAME = "PR500-WIFI-TEST";
static const int PIN_FORCE_PORTAL = 14;  // GND al arrancar -> forzar portal
static const int PIN_ADC = 36;           // ADC1_CH0
static const int PIN_R1 = 25;
static const int PIN_R2 = 26;
static const int PIN_R3 = 32;

// Tu módulo de relés es activo-bajo (LOW = ON).
static constexpr bool RELAY_ACTIVE_HIGH = false;
static inline int relayOnLevel() { return RELAY_ACTIVE_HIGH ? HIGH : LOW; }
static inline int relayOffLevel() { return RELAY_ACTIVE_HIGH ? LOW : HIGH; }
static inline bool relayIsOn(int pin) { return digitalRead(pin) == relayOnLevel(); }
static inline void relayWrite(int pin, bool on) { digitalWrite(pin, on ? relayOnLevel() : relayOffLevel()); }

struct Params {
  int F01_arm = 0;        // 0=OFF total, 1=habilitado
  float F02_sp = 2.0f;    // bar
  float F03_diff = 0.5f;  // bar
  float F04_stage = 0.4f; // bar entre etapas
  int F05_gap = 30;       // s entre arranques
  int F06_minOff = 120;   // s mínimo apagado
  int F07_minOn = 180;    // s mínimo encendido
  int F09_comp = 3;       // 1..3 compresores
  float F14_off = 0.0f;   // offset bar
} P;

WiFiManager wm;
unsigned long g_lastRetryMs = 0;
bool g_stageWant[3] = {false, false, false};
unsigned long g_onSince[3] = {0, 0, 0};
unsigned long g_offSince[3] = {0, 0, 0};
unsigned long g_lastStartMs = 0;
const int REL_PINS[3] = {PIN_R1, PIN_R2, PIN_R3};

static void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.persistent(false);
  wm.setConfigPortalTimeout(0);
  wm.setConnectTimeout(15);

  bool forcePortal = digitalRead(PIN_FORCE_PORTAL) == LOW;
  if (forcePortal) {
    Serial.println(F("[WiFi] Portal forzado por GPIO14."));
    WiFi.disconnect(true, true);
    delay(250);
    wm.startConfigPortal(AP_NAME);
  } else if (!wm.autoConnect(AP_NAME)) {
    Serial.println(F("[WiFi] autoConnect falló, abriendo portal."));
    WiFi.disconnect(true, true);
    delay(250);
    wm.startConfigPortal(AP_NAME);
  }
  Serial.printf("[WiFi] SSID=%s IP=%s RSSI=%d\n", WiFi.SSID().c_str(),
                WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
}

static void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (g_lastRetryMs != 0 && (now - g_lastRetryMs < 10000UL)) return;
  g_lastRetryMs = now;
  if (!WiFi.SSID().length()) return;
  Serial.printf("[WiFi] Reintentando conexión a %s...\n", WiFi.SSID().c_str());
  WiFi.reconnect();
}

static void setupRelaysSafe() {
  // Evitar pulsos al boot.
  digitalWrite(PIN_R1, relayOffLevel());
  digitalWrite(PIN_R2, relayOffLevel());
  digitalWrite(PIN_R3, relayOffLevel());
  pinMode(PIN_R1, OUTPUT);
  pinMode(PIN_R2, OUTPUT);
  pinMode(PIN_R3, OUTPUT);
  relayWrite(PIN_R1, false);
  relayWrite(PIN_R2, false);
  relayWrite(PIN_R3, false);
}

static float pressureBar() {
  analogSetPinAttenuation(PIN_ADC, ADC_11db);
  uint32_t acc = 0;
  for (int i = 0; i < 12; i++) {
    acc += analogRead(PIN_ADC);
    delay(2);
  }
  float raw = (acc / 12.0f) / 4095.0f;
  // Test simple: 0..3.3V -> 0..8 bar
  float bar = raw * 8.0f;
  return bar + P.F14_off;
}

static void updateHysteresis(float pbar) {
  int n = P.F09_comp;
  if (n < 1) n = 1;
  if (n > 3) n = 3;
  float d = P.F03_diff;
  if (d < 0.05f) d = 0.05f;
  float ds = P.F04_stage;
  if (ds < 0) ds = 0;
  for (int i = 0; i < 3; i++) {
    if (i >= n) {
      g_stageWant[i] = false;
      continue;
    }
    float onTh = P.F02_sp - d * 0.5f - i * ds;
    float offTh = P.F02_sp + d * 0.5f - i * ds;
    if (g_stageWant[i]) {
      if (pbar > offTh) g_stageWant[i] = false;
    } else {
      if (pbar < onTh) g_stageWant[i] = true;
    }
  }
}

static void applyRelays(unsigned long nowMs) {
  if (P.F01_arm == 0) {
    for (int i = 0; i < 3; i++) {
      if (relayIsOn(REL_PINS[i])) {
        relayWrite(REL_PINS[i], false);
        g_offSince[i] = nowMs;
        g_onSince[i] = 0;
      }
    }
    return;
  }

  uint32_t minOff = (uint32_t)max(0, P.F06_minOff) * 1000UL;
  uint32_t minOn = (uint32_t)max(0, P.F07_minOn) * 1000UL;
  uint32_t startGap = (uint32_t)max(0, P.F05_gap) * 1000UL;

  for (int i = 0; i < 3; i++) {
    bool cur = relayIsOn(REL_PINS[i]);
    bool target = g_stageWant[i];
    if (cur == target) continue;
    if (target) {
      bool offOk = (g_offSince[i] == 0) || (nowMs - g_offSince[i] >= minOff);
      bool gapOk = (g_lastStartMs == 0) || (nowMs - g_lastStartMs >= startGap);
      if (!offOk || !gapOk) continue;
      relayWrite(REL_PINS[i], true);
      g_onSince[i] = nowMs;
      g_lastStartMs = nowMs;
    } else {
      bool onOk = (g_onSince[i] == 0) || (nowMs - g_onSince[i] >= minOn);
      if (!onOk) continue;
      relayWrite(REL_PINS[i], false);
      g_offSince[i] = nowMs;
      g_onSince[i] = 0;
    }
  }
}

static void printStatus() {
  float p = pressureBar();
  Serial.printf("[WiFi] status=%d SSID=%s IP=%s RSSI=%d\n", (int)WiFi.status(),
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  Serial.printf("[PR500] P=%.2fbar ARM=%d SP=%.2f D=%.2f STAGE=%.2f comps=%d\n",
                p, P.F01_arm, P.F02_sp, P.F03_diff, P.F04_stage, P.F09_comp);
  Serial.printf("[REL] R1=%d R2=%d R3=%d (activo_%s)\n",
                relayIsOn(PIN_R1) ? 1 : 0, relayIsOn(PIN_R2) ? 1 : 0, relayIsOn(PIN_R3) ? 1 : 0,
                RELAY_ACTIVE_HIGH ? "alto" : "bajo");
}

static void handleSetCommand(String cmd) {
  cmd.toLowerCase();
  // Formato: set f02 2.4
  int p1 = cmd.indexOf(' ');
  int p2 = cmd.indexOf(' ', p1 + 1);
  if (p1 < 0 || p2 < 0) {
    Serial.println(F("Uso: set f01|f02|f03|f04|f05|f06|f07|f09|f14 <valor>"));
    return;
  }
  String key = cmd.substring(p1 + 1, p2);
  String val = cmd.substring(p2 + 1);
  val.trim();
  float n = val.toFloat();

  if (key == "f01") P.F01_arm = (n >= 1.0f) ? 1 : 0;
  else if (key == "f02") P.F02_sp = n;
  else if (key == "f03") P.F03_diff = n;
  else if (key == "f04") P.F04_stage = n;
  else if (key == "f05") P.F05_gap = (int)n;
  else if (key == "f06") P.F06_minOff = (int)n;
  else if (key == "f07") P.F07_minOn = (int)n;
  else if (key == "f09") P.F09_comp = (int)n;
  else if (key == "f14") P.F14_off = n;
  else {
    Serial.println(F("Parametro no reconocido."));
    return;
  }
  Serial.println(F("[SET] OK"));
  printStatus();
}

void setup() {
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
  setupRelaysSafe();
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\nESP32 PR500 TEST WIFI+PARAM+RELAY"));
  setupWifi();
  Serial.println(F("[INIT] Comandos: status | p | portal | reboot | set fxx v"));
  printStatus();
}

void loop() {
  maintainWifi();
  float p = pressureBar();
  updateHysteresis(p);
  applyRelays(millis());

  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    String low = cmd;
    low.toLowerCase();
    if (low == "status") {
      printStatus();
    } else if (low == "p") {
      Serial.printf("[P] %.3f bar\n", pressureBar());
    } else if (low == "portal") {
      Serial.println(F("[WiFi] Abriendo portal manual..."));
      WiFi.disconnect(true, false);
      delay(200);
      wm.startConfigPortal(AP_NAME);
      Serial.printf("[WiFi] Portal cerrado. SSID=%s IP=%s\n", WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str());
    } else if (low == "reboot") {
      ESP.restart();
    } else if (low.startsWith("set ")) {
      handleSetCommand(low);
    } else if (cmd.length() > 0) {
      Serial.println(F("Comandos: status | p | portal | reboot | set fxx valor"));
    }
  }

  delay(80);
}

