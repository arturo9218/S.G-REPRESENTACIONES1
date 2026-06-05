/**
 * AR Monitoreo — PRO400 (ESP8266 + 2× CD4094, 1 sonda, 1 relé)
 * -----------------------------------------------------------------
 * Plaqueta PRO300 (misma que PRO300): usá esp32_pro400_cd4094.ino (pines 23/18/5 y botones 13/14/27/17).
 * Este sketch ESP8266 solo si el módulo va cableado aparte (SPI 13/14/5; botones 4/12/0/16).
 * Parámetros F01–F26 + F50 (sin F25 ni F27), sync nube `fetch-pro400-params`.
 * Menú local: códigos A01…A24, A26, A50 en display 7-seg.
 *
 * Hardware:
 *   - NTC1 GPIO34. SPI CD4094: DATA=23, CLOCK=18, STROBE=5
 *   - Un solo relé en 4094#2 bit5 (misma plaqueta PRO300); bit6/7 sin usar
 *   - PRO400_SINGLE_RELAY: bit5 ON si compresor o deshielo activo
 *   - Botones: UP=13 DOWN=14 SET=27 BACK=17
 *   - GPIO0 a GND al encender → portal WiFi
 *   - DOOR_PIN: -1 sin sensor, o GPIO (ej. 33) + F26 entrada digital
 *
 * Dependencias: WiFiManager, ArduinoJson v6, core ESP8266 + LittleFS
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecureBearSSL.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <math.h>

static void runConfigPortal();
static void flashUiMessage(const char *msg, unsigned long ms = 1200UL);
static void pullParamsFromCloud();
static bool saveCurrentParamsToFs();
static void syncTelemetryInterval();

// ============== PINES =======================
#define DATA_PIN          13
#define CLOCK_PIN         14
#define STROBE_PIN        5
#define NTC1_PIN          A0
#define PIN_FORCE_PORTAL  2
#define DOOR_PIN         -1
#define BTN_UP_PIN        4
#define BTN_DOWN_PIN      12
#define BTN_SET_PIN       0
#define BTN_BACK_PIN      16
#define BTN_ACTIVE_LOW    1

#define BIT_COM1 0
#define BIT_COM2 1
#define BIT_COM3 2
#define BIT_COM4 3
#define BIT_COM5 4
#define BIT_COMP 5
#define BIT_DEF  6
#define BIT_FAN  7
#define PRO400_SINGLE_RELAY 1

// ============== CONFIG ======================
static constexpr const char *CFG_PATH     = "/config.json";
static constexpr const char *PARAMS_PATH  = "/pro400.json";
static constexpr const char *AP_NAME      = "PRO400-Setup";
static constexpr unsigned long PORTAL_TIMEOUT_SEC      = 5UL * 60UL;
static constexpr unsigned long WIFI_BOOT_CONNECT_MS    = 20000UL;
static constexpr unsigned long RELAY_BOOT_MIN_MS        = 10000UL;
static constexpr unsigned long PORTAL_WDT_TIMEOUT_MS    = 180000UL;
static constexpr unsigned long PARAMS_PULL_MS           = 60UL * 1000UL;
static constexpr unsigned long SENSOR_FAULT_GRACE_MS    = 45000UL;
static constexpr unsigned long DRIP_AFTER_DEFROST_S     = 120UL;
static constexpr float TEMP_ERR_VALUE = -127.0f;
static constexpr float CAMBIENT_HOT_C = 38.0f;
static constexpr float CHIP_TEMP_WARN_C = 68.0f;
static constexpr uint8_t NTC_FAULT_SET_COUNT = 3;
static constexpr uint8_t NTC_FAULT_CLR_COUNT = 2;

struct Cfg {
  char apiUrl[200] = "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";
  char moduleId[64] = "";
  char apiKey[48]   = "";
  uint32_t intervalMs = 60000UL;
} g_cfg;

/** Defaults = manual PRO400 (°C / s / min según parámetro). */
struct Pro400Params {
  float F01 = 4.0f;
  float F02 = 0.0f;
  float F03 = -50.0f;
  float F04 = 75.0f;
  float F05 = 1.0f;
  float F06 = 0.0f;
  float F07 = 20.0f;
  float F08 = 20.0f;
  float F09 = 240.0f;
  float F10 = 30.0f;
  float F11 = 0.0f;
  float F12 = 0.0f;
  float F13 = 0.0f;
  float F14 = 0.0f;
  float F15 = 0.0f;
  float F16 = 15.0f;
  float F17 = 15.0f;
  float F18 = 0.0f;
  float F19 = 0.0f;
  float F20 = 0.0f;
  float F21 = 2.0f;
  float F22 = 30.0f;
  float F23 = 0.0f;
  float F24 = 0.0f;
  float F26 = 0.0f;
  float F50 = 0.0f;
} P;

struct ParamMenuItem {
  const char *code;
  float *value;
  float step;
  float minValue;
  float maxValue;
};

static ParamMenuItem g_paramMenu[] = {
  {"01", &P.F01, 0.5f, -50.0f, 75.0f},
  {"02", &P.F02, 0.1f, -10.0f, 10.0f},
  {"03", &P.F03, 1.0f, -60.0f, 0.0f},
  {"04", &P.F04, 1.0f, 0.0f, 99.0f},
  {"05", &P.F05, 0.1f, 0.1f, 20.0f},
  {"06", &P.F06, 1.0f, 0.0f, 1.0f},
  {"07", &P.F07, 1.0f, 0.0f, 3600.0f},
  {"08", &P.F08, 1.0f, 0.0f, 3600.0f},
  {"09", &P.F09, 1.0f, 0.0f, 9999.0f},
  {"10", &P.F10, 1.0f, 1.0f, 999.0f},
  {"11", &P.F11, 1.0f, 0.0f, 1.0f},
  {"12", &P.F12, 1.0f, 0.0f, 1.0f},
  {"13", &P.F13, 1.0f, 0.0f, 999.0f},
  {"14", &P.F14, 1.0f, 0.0f, 999.0f},
  {"15", &P.F15, 1.0f, 0.0f, 2.0f},
  {"16", &P.F16, 1.0f, 1.0f, 999.0f},
  {"17", &P.F17, 1.0f, 1.0f, 999.0f},
  {"18", &P.F18, 1.0f, 0.0f, 9.0f},
  {"19", &P.F19, 1.0f, 0.0f, 999.0f},
  {"20", &P.F20, 1.0f, 0.0f, 2.0f},
  {"21", &P.F21, 1.0f, 0.0f, 2.0f},
  {"22", &P.F22, 5.0f, 10.0f, 3600.0f},
  {"23", &P.F23, 0.1f, 0.0f, 20.0f},
  {"24", &P.F24, 1.0f, 0.0f, 1.0f},
  {"26", &P.F26, 1.0f, 0.0f, 2.0f},
  {"50", &P.F50, 1.0f, 0.0f, 1.0f},
};
#define PARAM_MENU_COUNT ((int)(sizeof(g_paramMenu) / sizeof(g_paramMenu[0])))

static String g_paramsUpdatedAt = "";

enum Phase { PH_OFF, PH_BOOT, PH_NORMAL, PH_DEFROST, PH_DRIP, PH_EMERG };
static Phase g_phase = PH_BOOT;
static unsigned long g_phaseStartedAt = 0;
static uint32_t g_phaseTotalS = 0;

static bool compresor = false;
static bool ventilador = false;
static bool deshielo = false;
static bool dripping = false;
static bool emergencyComp = false;
static unsigned long compChangedAt = 0;
static unsigned long emergencyChangedAt = 0;
static unsigned long defStartedAt = 0;
static unsigned long dripStartedAt = 0;
static unsigned long lastDefrostEndAt = 0;
static unsigned long bootAtMs = 0;
static unsigned long relaySafeUntilMs = 0;
static unsigned long keysLockUntilMs = 0;
static bool bootDelayDone = false;
static bool defrostOnStartDone = false;
static bool firstCompCycleDone = false;

static float tCam = TEMP_ERR_VALUE;
static float tEma = TEMP_ERR_VALUE;
static bool fault1 = false;
static uint8_t ntcBadStreak = 0;
static uint8_t ntcGoodStreak = 0;
static bool ntcReady = false;

static bool doorOpen = false;
static unsigned long doorChangedAt = 0;

static bool modoTexto = true;
static String texto = "BOOT";
static int scrollPos = 0;
static byte bufferDisplay[4] = {0xFF, 0xFF, 0xFF, 0xFF};
static int digitNow = 0;
static unsigned long lastScroll = 0;
static unsigned long lastReadAt = 0;
static unsigned long lastDisplaySwitchAt = 0;

enum UiMode { UI_NORMAL, UI_PARAM_SELECT, UI_PARAM_EDIT };
static UiMode g_uiMode = UI_NORMAL;
static int g_paramCursor = 0;
static float g_paramEditOriginal = 0.0f;
static bool g_menuWaitRelease = false;
static unsigned long g_btnBothPressedAt = 0;
static unsigned long g_btnLastEdgeMs[4] = {0, 0, 0, 0};
static bool g_btnPrev[4] = {false, false, false, false};
static unsigned long g_editRepeatAt = 0;

enum NormalDispMode { DISP_TEMP = 0, DISP_PHASE = 1, DISP_REMAIN = 2 };
static NormalDispMode g_normalDisp = DISP_TEMP;

static WiFiManager wm;
static bool g_portalSaveRequested = false;
static bool g_portalRunning = false;
static bool g_prevWifiConnected = false;
static unsigned long g_lastDisplayRefresh = 0;
static unsigned long g_lastTel = 0;
static unsigned long g_lastPull = 0;
static unsigned long g_lastWifiRetry = 0;

static WiFiManagerParameter p_module("module_id", "Module ID (alta PRO400)", "", 47);
static WiFiManagerParameter p_token("api_key", "Device Token (6+ chars)", "", 47);
static WiFiManagerParameter p_url(
  "api_url",
  "Ingest URL",
  "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading",
  199);

enum FlashPri { FP_NONE = 0, FP_WIFI, FP_CALOR, FP_ENVIADO, FP_ENVIANDO, FP_PARAM };
static volatile uint8_t g_flashPending = FP_NONE;
static bool g_flashActive = false;
static unsigned long g_flashEndsAt = 0;

static volatile bool g_immediateTxRequested = false;
static unsigned long g_lastImmediateTxAt = 0;
static constexpr unsigned long IMMEDIATE_TX_MIN_GAP_MS = 5000UL;
static bool g_pullNowRequested = false;
static bool g_serialForceDefrost = false;
static bool g_manualCancelDefrost = false;
static unsigned long g_portalComboHeldAt = 0;
static unsigned long g_portalComboReleasedAt = 0;
static bool g_portalHoldHintShown = false;
static unsigned long g_upDefrostHeldAt = 0;
static bool g_upDefrostHoldFired = false;
static unsigned long g_setHeldAt = 0;
static bool g_setHoldMenuDone = false;

static float prevTempReported = TEMP_ERR_VALUE;
static bool prevCompresor = false;
static bool prevVentilador = false;
static bool prevDeshielo = false;

static constexpr float R_FIXED = 10000.0f;
static constexpr float BETA = 3950.0f;
static constexpr float T0K = 298.15f;
static constexpr float R0 = 10000.0f;

static constexpr unsigned long BTN_DEBOUNCE_MS = 35UL;
static constexpr unsigned long BTN_ENTER_PARAMS_HOLD_MS = 1200UL;
static constexpr unsigned long BTN_WIFI_PORTAL_HOLD_MS = 800UL;
static constexpr unsigned long BTN_WIFI_SET_SOLO_HOLD_MS = 4000UL;
static constexpr unsigned long BTN_PORTAL_RELEASE_DEBOUNCE_MS = 80UL;
static constexpr unsigned long BTN_DEFROST_HOLD_MS = 1200UL;
static constexpr unsigned long BTN_EDIT_REPEAT_MS = 280UL;

static void requestManualDefrostFromButton() {
  if (deshielo || dripping) {
    Serial.println(F("[BTN] Ya en deshielo/goteo."));
    return;
  }
  g_serialForceDefrost = true;
  flashUiMessage("DESh", 800);
  Serial.println(F("[BTN] Deshielo manual (UP 1,2s)."));
}

// ============== 7-seg / 4094 =================
static const byte num7seg[10] = {
  0b11000000, 0b11111001, 0b10100100, 0b10110000, 0b10011001,
  0b10010010, 0b10000010, 0b11111000, 0b10000000, 0b10010000
};
#define BLANCO 0b11111111
#define MENOS  0b10111111

static byte mapaChar(char c) {
  c = toupper(c);
  switch (c) {
    case '0': return num7seg[0]; case '1': return num7seg[1];
    case '2': return num7seg[2]; case '3': return num7seg[3];
    case '4': return num7seg[4]; case '5': return num7seg[5];
    case '6': return num7seg[6]; case '7': return num7seg[7];
    case '8': return num7seg[8]; case '9': return num7seg[9];
    case 'A': return 0b10001000; case 'B': return 0b10000011;
    case 'C': return 0b11000110; case 'D': return 0b10100001;
    case 'E': return 0b10000110; case 'F': return 0b10001110;
    case 'G': return 0b11000010; case 'H': return 0b10001001;
    case 'I': return 0b11111001; case 'L': return 0b11000111;
    case 'N': return 0b10101011; case 'O': return 0b11000000;
    case 'P': return 0b10001100; case 'R': return 0b10101111;
    case 'S': return 0b10010010; case 'T': return 0b10000111;
    case 'U': return 0b11000001; case '-': return MENOS;
    default:  return BLANCO;
  }
}

static byte relayMask() {
  byte b = 0;
  const bool inv = P.F50 >= 0.5f;
#if PRO400_SINGLE_RELAY
  const bool relayOn = compresor || deshielo;
  if (inv ? !relayOn : relayOn) b |= (1 << BIT_COMP);
#else
  if (inv ? !compresor : compresor) b |= (1 << BIT_COMP);
  if (inv ? !deshielo : deshielo) b |= (1 << BIT_DEF);
  if (inv ? !ventilador : ventilador) b |= (1 << BIT_FAN);
#endif
  return b;
}
static byte comunesApagados() { return 0b00011111 | relayMask(); }
static byte activarCom(int com) {
  byte b = comunesApagados();
  b &= ~(1 << com);
  return b;
}
static void enviar4094(byte cm, byte sg) {
  digitalWrite(STROBE_PIN, LOW);
  SPI.transfer(cm);
  SPI.transfer(sg);
  digitalWrite(STROBE_PIN, HIGH);
  digitalWrite(STROBE_PIN, LOW);
}
static void refrescarDisplay() {
  enviar4094(comunesApagados(), 0xFF);
  if (digitNow < 4) {
    enviar4094(activarCom(digitNow), bufferDisplay[digitNow]);
  } else {
    byte luces = 0xFF;
#if PRO400_SINGLE_RELAY
    if (compresor || deshielo) luces &= ~(1 << 0);
#else
    if (compresor)  luces &= ~(1 << 0);
    if (deshielo)   luces &= ~(1 << 1);
    if (ventilador) luces &= ~(1 << 2);
#endif
    enviar4094(activarCom(BIT_COM5), luces);
  }
  if (++digitNow > 4) digitNow = 0;
}

static String adaptarTexto(String t) {
  t.toUpperCase();
  t.replace("M", "N");
  t.replace("V", "U");
  return t;
}
static void prepararTexto() {
  String t = "    " + adaptarTexto(texto) + "    ";
  for (int i = 0; i < 4; i++) {
    int idx = scrollPos + i;
    if (idx >= (int)t.length()) { bufferDisplay[i] = BLANCO; continue; }
    char c = t[idx];
    if (c == '.') {
      if (i > 0) bufferDisplay[i - 1] &= 0b01111111;
      bufferDisplay[i] = BLANCO;
    } else {
      bufferDisplay[i] = mapaChar(c);
    }
  }
  scrollPos++;
  if (scrollPos > (int)t.length() - 4) scrollPos = 0;
}

static void mostrarTemperatura(float temp) {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bool neg = temp < 0;
  if (neg) temp = -temp;
  int valor = (int)round(temp * 10);
  int entero = valor / 10;
  int dec = valor % 10;
  bufferDisplay[3] = num7seg[dec];
  if (entero >= 100) {
    bufferDisplay[0] = num7seg[(entero / 100) % 10];
    bufferDisplay[1] = num7seg[(entero / 10) % 10];
    bufferDisplay[2] = num7seg[entero % 10] & 0b01111111;
  } else if (entero >= 10) {
    bufferDisplay[1] = num7seg[entero / 10];
    bufferDisplay[2] = num7seg[entero % 10] & 0b01111111;
    if (neg) bufferDisplay[0] = MENOS;
  } else {
    bufferDisplay[2] = num7seg[entero] & 0b01111111;
    if (neg) bufferDisplay[1] = MENOS;
  }
}

static void mostrarError1() {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bufferDisplay[1] = mapaChar('E');
  bufferDisplay[2] = num7seg[1];
}

static void mostrarTextoFijo4(const char *t) {
  for (int i = 0; i < 4; i++) {
    char c = (t && t[i]) ? t[i] : ' ';
    bufferDisplay[i] = mapaChar(c);
  }
}

static void showParamCodeOnDisplay(const char *code) {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bufferDisplay[0] = mapaChar('A');
  bufferDisplay[1] = mapaChar(code[0]);
  bufferDisplay[2] = mapaChar(code[1]);
}

static void setPhase(Phase p, uint32_t totalS = 0) {
  if (g_phase == p) {
    g_phaseTotalS = totalS;
    return;
  }
  g_phase = p;
  g_phaseStartedAt = millis();
  g_phaseTotalS = totalS;
}

static uint32_t phaseRemainingS() {
  const uint32_t elapsed = (uint32_t)((millis() - g_phaseStartedAt) / 1000UL);
  if (g_phaseTotalS > elapsed) return g_phaseTotalS - elapsed;
  return 0;
}

static const char *phaseDisplayLabel(Phase p) {
  switch (p) {
    case PH_DEFROST: return "DESh";
    case PH_DRIP:    return "GOTE";
    case PH_NORMAL:  return "FRIO";
    case PH_BOOT:    return "INIC";
    case PH_OFF:     return "APAG";
    case PH_EMERG:   return "ALRM";
    default:         return "----";
  }
}

static void mostrarFaseActual() {
  mostrarTextoFijo4(phaseDisplayLabel(g_phase));
}

static void mostrarMinutosRestantesFase() {
  mostrarTemperatura((float)phaseRemainingS() / 60.0f);
}

static void refreshNormalDisplay() {
  if (P.F12 >= 0.5f && (deshielo || dripping)) {
    mostrarFaseActual();
    return;
  }
  switch (g_normalDisp) {
    case DISP_PHASE:
      mostrarFaseActual();
      break;
    case DISP_REMAIN:
      mostrarMinutosRestantesFase();
      break;
    default:
      if (fault1) mostrarError1();
      else mostrarTemperatura(tCam);
      break;
  }
}

static void pushFlash(uint8_t k) {
  if (k == FP_NONE) return;
  if (g_flashPending == FP_NONE || k < g_flashPending) g_flashPending = k;
}

static const char *flashText(uint8_t k) {
  switch (k) {
    case FP_WIFI:     return "WIFI OK   ";
    case FP_CALOR:    return "CALOR     ";
    case FP_ENVIADO:  return "ENVIADO   ";
    case FP_ENVIANDO: return "ENVIANDO  ";
    case FP_PARAM:    return "PARAM OK  ";
    default:          return "        ";
  }
}

static unsigned long flashDurationMs(uint8_t k) {
  if (k == FP_ENVIANDO) return 1400UL;
  if (k == FP_WIFI || k == FP_CALOR) return 3200UL;
  return 3800UL;
}

static void flashUiMessage(const char *msg, unsigned long ms) {
  modoTexto = true;
  texto = msg;
  scrollPos = 0;
  prepararTexto();
  g_flashActive = true;
  g_flashEndsAt = millis() + ms;
}

static void serviceUiFlash(unsigned long now) {
  if (g_portalRunning) return;
  if (g_flashActive && now < g_flashEndsAt) {
    if (modoTexto && now - lastScroll >= 300) {
      lastScroll = now;
      prepararTexto();
    }
    return;
  }
  const uint8_t p = g_flashPending;
  if (p != FP_NONE) {
    g_flashPending = FP_NONE;
    flashUiMessage(flashText(p), flashDurationMs(p));
    return;
  }
  if (g_flashActive) {
    g_flashActive = false;
    if (g_uiMode == UI_NORMAL) modoTexto = false;
  }
}

static void aplicarDeratingCalor(unsigned long now) {
  static unsigned long lastWarn = 0;
  const bool hot = !fault1 && tCam >= CAMBIENT_HOT_C;
  if (hot) {
    WiFi.setOutputPower(11.0f);
    if (lastWarn == 0 || now - lastWarn >= 90000UL) {
      lastWarn = now;
      pushFlash(FP_CALOR);
      Serial.printf("[CALOR] sonda=%.1f\n", tCam);
    }
  } else {
    WiFi.setOutputPower(20.5f);
  }
}

// ============== FS / params =================
static bool ensureFs() {
  static bool ok = false;
  if (ok) return true;
  ok = LittleFS.begin();
  return ok;
}

static bool httpPostJson(const char *url, const String &body, String *outResp, int *outCode) {
  std::unique_ptr<BearSSL::WiFiClientSecure> secure(new BearSSL::WiFiClientSecure);
  secure->setInsecure();
  HTTPClient http;
  http.setTimeout(12000);
  if (!http.begin(*secure, url)) return false;
  http.addHeader("Content-Type", "application/json");
  const int code = http.POST(body);
  String resp = http.getString();
  http.end();
  if (outCode) *outCode = code;
  if (outResp) *outResp = resp;
  return code >= 200 && code < 300;
}

static bool loadConfig() {
  if (!ensureFs() || !LittleFS.exists(CFG_PATH)) return false;
  File f = LittleFS.open(CFG_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, f)) { f.close(); return false; }
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
  #define ASSIGN(K) do { auto v = obj[#K]; if (!v.isNull()) P.K = v.as<float>(); } while (0)
  ASSIGN(F01); ASSIGN(F02); ASSIGN(F03); ASSIGN(F04); ASSIGN(F05);
  ASSIGN(F06); ASSIGN(F07); ASSIGN(F08); ASSIGN(F09); ASSIGN(F10);
  ASSIGN(F11); ASSIGN(F12); ASSIGN(F13); ASSIGN(F14); ASSIGN(F15);
  ASSIGN(F16); ASSIGN(F17); ASSIGN(F18); ASSIGN(F19); ASSIGN(F20);
  ASSIGN(F21); ASSIGN(F22); ASSIGN(F23); ASSIGN(F24); ASSIGN(F26);
  ASSIGN(F50);
  #undef ASSIGN
  if (P.F03 > P.F04) { float t = P.F03; P.F03 = P.F04; P.F04 = t; }
  if (P.F01 < P.F03) P.F01 = P.F03;
  if (P.F01 > P.F04) P.F01 = P.F04;
}

static void loadParams() {
  if (!ensureFs() || !LittleFS.exists(PARAMS_PATH)) return;
  File f = LittleFS.open(PARAMS_PATH, "r");
  if (!f) return;
  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, f) != DeserializationError::Ok) { f.close(); return; }
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

static bool saveCurrentParamsToFs() {
  StaticJsonDocument<1024> doc;
  JsonObject p = doc.createNestedObject("params");
  #define STORE(K) p[#K] = P.K
  STORE(F01); STORE(F02); STORE(F03); STORE(F04); STORE(F05);
  STORE(F06); STORE(F07); STORE(F08); STORE(F09); STORE(F10);
  STORE(F11); STORE(F12); STORE(F13); STORE(F14); STORE(F15);
  STORE(F16); STORE(F17); STORE(F18); STORE(F19); STORE(F20);
  STORE(F21); STORE(F22); STORE(F23); STORE(F24); STORE(F26);
  STORE(F50);
  #undef STORE
  return saveParams(p);
}

static void syncTelemetryInterval() {
  if (P.F21 >= 1.0f) {
    unsigned long ms = (unsigned long)(P.F22 * 1000.0f);
    if (ms < 60000UL) ms = 60000UL;
    g_cfg.intervalMs = ms;
  } else {
    g_cfg.intervalMs = 300000UL;
  }
}

static float clampParamValue(float v, float minV, float maxV) {
  if (v < minV) v = minV;
  if (v > maxV) v = maxV;
  return v;
}

static float clampSetpoint(float sp) {
  return clampParamValue(sp, P.F03, P.F04);
}

// ============== NTC + EMA ===================
static float leerNTCRaw(bool &rawFault) {
  long acc = 0;
  int validas = 0;
  for (int i = 0; i < 8; i++) {
    int v = analogRead(NTC1_PIN);
    if (v > 5 && v < 1020) { acc += v; validas++; }
    delayMicroseconds(200);
  }
  if (validas < 4) { rawFault = true; return TEMP_ERR_VALUE; }
  int adc = acc / validas;
  float rNTC = R_FIXED * ((float)adc / (1023.0f - (float)adc));
  float tK = 1.0f / ((1.0f / T0K) + (1.0f / BETA) * log(rNTC / R0));
  float tC = tK - 273.15f;
  if (tC < -45.0f || tC > 80.0f) { rawFault = true; return TEMP_ERR_VALUE; }
  rawFault = false;
  return tC + P.F02;
}

static void applyEma(float raw) {
  const int level = (int)P.F18;
  if (level <= 0 || raw <= -100.0f) {
    tCam = raw;
    return;
  }
  const float alpha = 1.0f / (float)(level + 1);
  if (tEma <= -100.0f) tEma = raw;
  else tEma += alpha * (raw - tEma);
  tCam = tEma;
}

static void updateFault(bool rawFault) {
  if (rawFault) {
    if (ntcBadStreak < 255) ntcBadStreak++;
    ntcGoodStreak = 0;
    if (ntcBadStreak >= NTC_FAULT_SET_COUNT) fault1 = true;
  } else {
    if (ntcGoodStreak < 255) ntcGoodStreak++;
    ntcBadStreak = 0;
    if (ntcGoodStreak >= NTC_FAULT_CLR_COUNT) fault1 = false;
  }
  if (!rawFault) ntcReady = true;
}

// ============== Puerta (F26) =================
static void leerPuerta() {
  if (DOOR_PIN < 0 || P.F26 < 0.5f) {
    doorOpen = false;
    return;
  }
  const int v = digitalRead(DOOR_PIN);
  const bool isOpenRaw = (P.F26 >= 1.5f) ? (v == HIGH) : (v == LOW);
  if (isOpenRaw != doorOpen) {
    doorOpen = isOpenRaw;
    doorChangedAt = millis();
    Serial.printf("[PUERTA] %s\n", doorOpen ? "ABIERTA" : "CERRADA");
  }
}

// ============== Control helpers =============
static bool needCompressorOn(float t, float sp, float diff) {
  if (P.F06 >= 0.5f) return t <= sp - diff;
  return t >= sp + diff;
}

static bool reachedSetpoint(float t, float sp) {
  if (P.F06 >= 0.5f) return t >= sp;
  return t <= sp;
}

static unsigned long effectiveMinOnMs() {
  unsigned long ms = (unsigned long)(P.F07 * 1000.0f);
  if (!firstCompCycleDone && P.F14 > 0.0f) {
    ms += (unsigned long)(P.F14 * 60.0f * 1000.0f);
  }
  return ms;
}

static void startDefrost(unsigned long now) {
  deshielo = true;
  defStartedAt = now;
  if (compresor) { compresor = false; compChangedAt = now; }
  ventilador = false;
  setPhase(PH_DEFROST, (uint32_t)(P.F10 * 60.0f));
  Serial.println(F("[DEF] Inicio deshielo electrico"));
}

// ============== Control principal ===========
static void aplicarControl() {
  const unsigned long now = millis();

  if (g_manualCancelDefrost) {
    g_manualCancelDefrost = false;
    if (deshielo) {
      deshielo = false;
      dripping = true;
      dripStartedAt = now;
      compresor = false;
      ventilador = false;
      compChangedAt = now;
      setPhase(PH_DRIP, DRIP_AFTER_DEFROST_S);
      Serial.println(F("[BTN] Deshielo cancelado → goteo"));
      return;
    }
  }

  if (now < relaySafeUntilMs) {
    compresor = ventilador = deshielo = false;
    dripping = false;
    emergencyComp = false;
    const uint32_t remS = (uint32_t)((relaySafeUntilMs - now + 999UL) / 1000UL);
    setPhase(PH_BOOT, remS > 0 ? remS : 1);
    return;
  }

  if (!bootDelayDone) {
    bootDelayDone = true;
    compChangedAt = now;
    lastDefrostEndAt = now;
    Serial.printf("[BOOT] Fin retardo F13=%.0f min (min %lus relés OFF)\n",
                  P.F13, (unsigned long)(RELAY_BOOT_MIN_MS / 1000UL));
    if (P.F11 >= 0.5f && !defrostOnStartDone) {
      defrostOnStartDone = true;
      startDefrost(now);
      return;
    }
    defrostOnStartDone = true;
  }

  if (fault1) {
    deshielo = false;
    dripping = false;
    if ((now - bootAtMs) < SENSOR_FAULT_GRACE_MS) {
      compresor = ventilador = false;
      emergencyComp = false;
      setPhase(PH_OFF, 0);
      return;
    }
    const int mode = (int)P.F15;
    if (mode <= 0) {
      compresor = ventilador = false;
      emergencyComp = false;
      setPhase(PH_OFF, 0);
      return;
    }
    if (mode >= 2) {
      compresor = true;
      ventilador = true;
      setPhase(PH_EMERG, 0);
      return;
    }
    setPhase(PH_EMERG, 0);
    const unsigned long onMs = (unsigned long)(P.F16 * 60.0f * 1000.0f);
    const unsigned long offMs = (unsigned long)(P.F17 * 60.0f * 1000.0f);
    if (emergencyComp) {
      if (now - emergencyChangedAt >= onMs) {
        emergencyComp = false;
        emergencyChangedAt = now;
      }
    } else if (now - emergencyChangedAt >= offMs) {
      emergencyComp = true;
      emergencyChangedAt = now;
    }
    compresor = emergencyComp;
    ventilador = emergencyComp;
    return;
  }
  emergencyComp = false;

  if (deshielo) {
    const bool finTiempo = (now - defStartedAt) >= (unsigned long)(P.F10 * 60.0f * 1000.0f);
    if (finTiempo) {
      deshielo = false;
      dripping = true;
      dripStartedAt = now;
      compresor = false;
      ventilador = false;
      setPhase(PH_DRIP, DRIP_AFTER_DEFROST_S);
      Serial.println(F("[DEF] Fin deshielo → goteo"));
    } else {
      compresor = false;
      ventilador = false;
      setPhase(PH_DEFROST, (uint32_t)(P.F10 * 60.0f));
    }
    return;
  }

  if (dripping) {
    compresor = false;
    ventilador = false;
    if ((now - dripStartedAt) >= DRIP_AFTER_DEFROST_S * 1000UL) {
      dripping = false;
      lastDefrostEndAt = now;
      Serial.println(F("[DEF] Goteo OK → refrigeracion"));
    } else {
      setPhase(PH_DRIP, DRIP_AFTER_DEFROST_S);
      return;
    }
  }

  const bool intervalDue = (P.F09 > 0.0f) &&
      (now - lastDefrostEndAt) >= (unsigned long)(P.F09 * 60.0f * 1000.0f);
  if ((intervalDue || g_serialForceDefrost) && !doorOpen) {
    g_serialForceDefrost = false;
    startDefrost(now);
    return;
  }

  const float sp = P.F01;
  const float diff = P.F05;
  const unsigned long minOnMs = effectiveMinOnMs();
  const unsigned long minOffMs = (unsigned long)(P.F08 * 1000.0f);

  if (compresor) {
    if ((reachedSetpoint(tCam, sp) || doorOpen) &&
        (now - compChangedAt) >= minOnMs) {
      compresor = false;
      compChangedAt = now;
      if (!firstCompCycleDone) firstCompCycleDone = true;
    }
  } else {
    if (needCompressorOn(tCam, sp, diff) && !doorOpen &&
        (now - compChangedAt) >= minOffMs) {
      compresor = true;
      compChangedAt = now;
    }
  }
  ventilador = compresor;
  setPhase(compresor ? PH_NORMAL : PH_OFF, 0);
}

// ============== Botones =====================
static bool btnPressed(int pin) {
#if BTN_ACTIVE_LOW
  return digitalRead(pin) == LOW;
#else
  return digitalRead(pin) == HIGH;
#endif
}

static void syncBtnPrevFromPins() {
  const int pins[4] = {BTN_UP_PIN, BTN_DOWN_PIN, BTN_SET_PIN, BTN_BACK_PIN};
  for (int i = 0; i < 4; i++) g_btnPrev[i] = btnPressed(pins[i]);
}

static bool anyBtnPressed() {
  return btnPressed(BTN_UP_PIN) || btnPressed(BTN_DOWN_PIN) ||
         btnPressed(BTN_SET_PIN) || btnPressed(BTN_BACK_PIN);
}

static bool consumePressEdge(int pin, int idx, unsigned long nowMs) {
  const bool cur = btnPressed(pin);
  const bool prev = g_btnPrev[idx];
  g_btnPrev[idx] = cur;
  if (!cur || prev) return false;
  if (nowMs - g_btnLastEdgeMs[idx] < BTN_DEBOUNCE_MS) return false;
  g_btnLastEdgeMs[idx] = nowMs;
  return true;
}

static bool portalComboHeldNow() {
  if (!btnPressed(BTN_SET_PIN)) return false;
  if (btnPressed(BTN_DOWN_PIN)) return true;
  if (btnPressed(BTN_UP_PIN) && !btnPressed(BTN_DOWN_PIN)) return true;
  if (btnPressed(BTN_BACK_PIN) && !btnPressed(BTN_UP_PIN) && !btnPressed(BTN_DOWN_PIN)) return true;
  return false;
}

static bool handlePortalComboHold(unsigned long now) {
  if (g_portalRunning) return true;
  if (portalComboHeldNow()) {
    g_portalComboReleasedAt = 0;
    if (g_portalComboHeldAt == 0) g_portalComboHeldAt = now;
    const unsigned long held = now - g_portalComboHeldAt;
    if (!g_portalHoldHintShown && held >= 300UL) {
      g_portalHoldHintShown = true;
      flashUiMessage("WIFI...   ", 900);
    }
    if (held >= BTN_WIFI_PORTAL_HOLD_MS) {
      g_portalComboHeldAt = 0;
      g_portalHoldHintShown = false;
      g_uiMode = UI_NORMAL;
      g_menuWaitRelease = true;
      syncBtnPrevFromPins();
      runConfigPortal();
      Serial.println(F("[BTN] SET+combo → portal PRO400-Setup"));
    }
    return true;
  }
  if (g_portalComboHeldAt != 0) {
    if (g_portalComboReleasedAt == 0) g_portalComboReleasedAt = now;
    if (now - g_portalComboReleasedAt >= BTN_PORTAL_RELEASE_DEBOUNCE_MS) {
      g_portalComboHeldAt = 0;
      g_portalComboReleasedAt = 0;
      g_portalHoldHintShown = false;
    }
  }
  return false;
}

static void handleButtonUi() {
  const unsigned long now = millis();
  if (P.F19 > 0.0f && now < keysLockUntilMs) return;
  const bool upHeld = btnPressed(BTN_UP_PIN);
  const bool downHeld = btnPressed(BTN_DOWN_PIN);
  const bool setHeld = btnPressed(BTN_SET_PIN);

  if (handlePortalComboHold(now)) return;
  if (g_portalRunning) return;

  if (g_uiMode == UI_NORMAL) {
    if (!g_flashActive && g_flashPending == FP_NONE) modoTexto = false;
    const bool upEdgeEarly = consumePressEdge(BTN_UP_PIN, 0, now);
    const bool downEdgeEarly = consumePressEdge(BTN_DOWN_PIN, 1, now);
    const bool backEdgeEarly = consumePressEdge(BTN_BACK_PIN, 3, now);

    if (backEdgeEarly && !upHeld && !downHeld && !setHeld) {
      g_normalDisp = DISP_TEMP;
      refreshNormalDisplay();
      Serial.println(F("[BTN] VOLVER → temperatura"));
      syncBtnPrevFromPins();
      return;
    }

    if (upEdgeEarly && (deshielo || dripping)) {
      g_manualCancelDefrost = true;
      flashUiMessage("STOP", 900);
      Serial.println(F("[BTN] UP toque: cancelar deshielo"));
      syncBtnPrevFromPins();
      return;
    }

    if (downEdgeEarly && !upHeld && !setHeld) {
      g_normalDisp = (NormalDispMode)(((int)g_normalDisp + 1) % 3);
      refreshNormalDisplay();
      Serial.printf("[BTN] Vista=%d\n", (int)g_normalDisp);
      syncBtnPrevFromPins();
      return;
    }

    if (upHeld && downHeld && !setHeld) {
      g_upDefrostHeldAt = 0;
      g_upDefrostHoldFired = false;
      g_portalComboHeldAt = 0;
      g_portalHoldHintShown = false;
      g_setHeldAt = 0;
      if (g_btnBothPressedAt == 0) g_btnBothPressedAt = now;
      if (now - g_btnBothPressedAt >= BTN_ENTER_PARAMS_HOLD_MS) {
        g_uiMode = UI_PARAM_SELECT;
        g_paramCursor = 0;
        g_btnBothPressedAt = 0;
        g_menuWaitRelease = true;
        syncBtnPrevFromPins();
        showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
        flashUiMessage("MENU", 800);
        Serial.println(F("[BTN] UP+DOWN → menú A01"));
      }
    } else if (upHeld && !downHeld && !setHeld) {
      g_btnBothPressedAt = 0;
      g_setHeldAt = 0;
      if (g_upDefrostHeldAt == 0) g_upDefrostHeldAt = now;
      if (!g_upDefrostHoldFired && (now - g_upDefrostHeldAt >= BTN_DEFROST_HOLD_MS)) {
        g_upDefrostHoldFired = true;
        requestManualDefrostFromButton();
      }
    } else if (setHeld && !upHeld && !downHeld) {
      g_upDefrostHeldAt = 0;
      g_upDefrostHoldFired = false;
      g_btnBothPressedAt = 0;
      if (g_setHeldAt == 0) g_setHeldAt = now;
      const unsigned long setHeldMs = now - g_setHeldAt;
      if (setHeldMs >= BTN_WIFI_SET_SOLO_HOLD_MS) {
        g_setHeldAt = 0;
        g_setHoldMenuDone = false;
        g_uiMode = UI_NORMAL;
        g_menuWaitRelease = true;
        syncBtnPrevFromPins();
        runConfigPortal();
        Serial.println(F("[BTN] SET 4s → portal WiFi"));
        return;
      }
      if (setHeldMs >= BTN_ENTER_PARAMS_HOLD_MS && !g_setHoldMenuDone) {
        g_setHoldMenuDone = true;
        g_uiMode = UI_PARAM_SELECT;
        g_paramCursor = 0;
        g_menuWaitRelease = true;
        syncBtnPrevFromPins();
        showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
        flashUiMessage("MENU", 800);
        Serial.println(F("[BTN] SET 1,2s → menú A01"));
      }
    } else {
      g_btnBothPressedAt = 0;
      g_setHeldAt = 0;
      g_setHoldMenuDone = false;
      g_upDefrostHeldAt = 0;
      g_upDefrostHoldFired = false;
    }
    syncBtnPrevFromPins();
    return;
  }

  if (g_menuWaitRelease) {
    syncBtnPrevFromPins();
    if (anyBtnPressed()) return;
    g_menuWaitRelease = false;
  }

  modoTexto = false;
  const bool upEdge = consumePressEdge(BTN_UP_PIN, 0, now);
  const bool downEdge = consumePressEdge(BTN_DOWN_PIN, 1, now);
  const bool setEdge = consumePressEdge(BTN_SET_PIN, 2, now);
  const bool backEdge = consumePressEdge(BTN_BACK_PIN, 3, now);

  if (g_uiMode == UI_PARAM_SELECT) {
    if (upEdge) g_paramCursor = (g_paramCursor + 1) % PARAM_MENU_COUNT;
    else if (downEdge) g_paramCursor = (g_paramCursor - 1 + PARAM_MENU_COUNT) % PARAM_MENU_COUNT;
    if (upEdge || downEdge) showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
    if (setEdge) {
      g_paramEditOriginal = *g_paramMenu[g_paramCursor].value;
      g_uiMode = UI_PARAM_EDIT;
      mostrarTemperatura(*g_paramMenu[g_paramCursor].value);
      flashUiMessage("EDIT", 600);
    }
    if (backEdge) {
      g_uiMode = UI_NORMAL;
      g_normalDisp = DISP_TEMP;
      Serial.println(F("[BTN] Salir menu"));
    }
    return;
  }

  if (g_uiMode == UI_PARAM_EDIT) {
    ParamMenuItem &it = g_paramMenu[g_paramCursor];
    bool changed = false;
    if (upEdge) {
      *it.value = clampParamValue(*it.value + it.step, it.minValue, it.maxValue);
      changed = true;
      g_editRepeatAt = now;
    } else if (downEdge) {
      *it.value = clampParamValue(*it.value - it.step, it.minValue, it.maxValue);
      changed = true;
      g_editRepeatAt = now;
    } else if (upHeld && now - g_editRepeatAt >= BTN_EDIT_REPEAT_MS) {
      *it.value = clampParamValue(*it.value + it.step, it.minValue, it.maxValue);
      changed = true;
      g_editRepeatAt = now;
    } else if (downHeld && now - g_editRepeatAt >= BTN_EDIT_REPEAT_MS) {
      *it.value = clampParamValue(*it.value - it.step, it.minValue, it.maxValue);
      changed = true;
      g_editRepeatAt = now;
    }
    if (changed) {
      if (it.value == &P.F01) P.F01 = clampSetpoint(P.F01);
      if (it.value == &P.F03 || it.value == &P.F04) P.F01 = clampSetpoint(P.F01);
      mostrarTemperatura(*it.value);
    }
    if (setEdge) {
      P.F01 = clampSetpoint(P.F01);
      syncTelemetryInterval();
      const bool ok = saveCurrentParamsToFs();
      g_uiMode = UI_PARAM_SELECT;
      showParamCodeOnDisplay(it.code);
      flashUiMessage(ok ? "SAVE" : "ERR", 900);
      Serial.printf("[BTN] A%s=%.2f guardado\n", it.code, *it.value);
    }
    if (backEdge) {
      *it.value = g_paramEditOriginal;
      g_uiMode = UI_PARAM_SELECT;
      showParamCodeOnDisplay(it.code);
    }
  }
}

// ============== WiFi / cloud ================
static void copyPortalAndSave() {
  const char *mid = p_module.getValue();
  const char *tok = p_token.getValue();
  const char *u = p_url.getValue();
  if (mid && mid[0]) strlcpy(g_cfg.moduleId, mid, sizeof(g_cfg.moduleId));
  if (tok && tok[0]) strlcpy(g_cfg.apiKey, tok, sizeof(g_cfg.apiKey));
  if (u && strncmp(u, "https://", 8) == 0 && strstr(u, "/functions/v1/")) {
    strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  }
  saveConfig();
}

static bool connectSavedWifi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  if (WiFi.SSID().length() == 0) return false;
  WiFi.disconnect(false);
  delay(100);
  WiFi.begin();
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(250);
    yield();
  }
  if (WiFi.status() == WL_CONNECTED) {
    pushFlash(FP_WIFI);
    g_prevWifiConnected = true;
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
  wm.setConnectTimeout(45);
  wm.setSaveConnectTimeout(45);
  wm.setMinimumSignalQuality(-1);
  modoTexto = true;
  texto = "WIFI PRO400-SETUP 192.168.4.1 ";
  scrollPos = 0;
  prepararTexto();
  Serial.println(F("[WiFi] Portal PRO400-Setup"));
  wm.startConfigPortal(AP_NAME);
  if (g_portalSaveRequested) copyPortalAndSave();
  wm.stopConfigPortal();
  WiFi.softAPdisconnect(true);
  g_portalRunning = false;
  if (WiFi.status() != WL_CONNECTED) connectSavedWifi(30000UL);
  if (WiFi.status() == WL_CONNECTED) pushFlash(FP_WIFI);
  else if (g_uiMode == UI_NORMAL) modoTexto = false;
}

static void setupWifi() {
  WiFi.setSleepMode(WIFI_NONE);
  WiFi.persistent(true);
  wm.setSaveConfigCallback([]() { g_portalSaveRequested = true; });
  p_module.setValue(g_cfg.moduleId, sizeof(g_cfg.moduleId) - 1);
  p_token.setValue(g_cfg.apiKey, sizeof(g_cfg.apiKey) - 1);
  p_url.setValue(g_cfg.apiUrl, sizeof(g_cfg.apiUrl) - 1);
  wm.addParameter(&p_module);
  wm.addParameter(&p_token);
  wm.addParameter(&p_url);

  if (digitalRead(PIN_FORCE_PORTAL) == LOW ||
      strlen(g_cfg.moduleId) == 0 || strlen(g_cfg.apiKey) == 0) {
    runConfigPortal();
    return;
  }
  if (!connectSavedWifi(WIFI_BOOT_CONNECT_MS)) g_prevWifiConnected = false;
}

static String paramsUrl() {
  String u(g_cfg.apiUrl);
  int idx = u.lastIndexOf("/ingest-reading");
  if (idx > 0) {
    u.remove(idx);
    u += "/fetch-pro400-params";
    return u;
  }
  idx = u.lastIndexOf('/');
  if (idx > 0) {
    u.remove(idx);
    u += "/fetch-pro400-params";
  }
  return u;
}

static void pullParamsFromCloud() {
  if (P.F20 >= 1.0f) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!g_cfg.moduleId[0] || !g_cfg.apiKey[0]) return;

  const String url = paramsUrl();
  if (url.length() == 0) return;

  StaticJsonDocument<200> req;
  req["moduleId"] = g_cfg.moduleId;
  req["deviceToken"] = g_cfg.apiKey;
  String body;
  serializeJson(req, body);

  String resp;
  int code = 0;
  if (!httpPostJson(url.c_str(), body, &resp, &code)) {
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
  pushFlash(FP_PARAM);
}

static const char *phaseToJson(Phase p) {
  switch (p) {
    case PH_BOOT:    return "boot";
    case PH_NORMAL:  return "normal";
    case PH_DEFROST: return "defrost";
    case PH_DRIP:    return "drip";
    case PH_EMERG:   return "emerg";
    case PH_OFF:     return "off";
    default:         return "normal";
  }
}

static void enviarTelemetria() {
  if (P.F21 < 1.0f || P.F20 >= 2.0f) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!g_cfg.moduleId[0] || !g_cfg.apiKey[0]) return;

  pushFlash(FP_ENVIANDO);

  const uint32_t elapsedS = (uint32_t)((millis() - g_phaseStartedAt) / 1000UL);
  String body = "{";
  body += "\"moduleId\":\"" + String(g_cfg.moduleId) + "\",";
  body += "\"deviceToken\":\"" + String(g_cfg.apiKey) + "\",";
  if (!fault1) body += "\"temp1_c\":" + String(tCam, 2) + ",";
  else body += "\"temp1_c\":null,";
  body += "\"comp_on\":" + String(compresor ? "true" : "false") + ",";
  body += "\"fan_on\":" + String(ventilador ? "true" : "false") + ",";
  body += "\"defrost_on\":" + String(deshielo ? "true" : "false") + ",";
  body += "\"phase\":\"" + String(phaseToJson(g_phase)) + "\",";
  body += "\"phase_elapsed_s\":" + String(elapsedS) + ",";
  body += "\"phase_total_s\":" + String(g_phaseTotalS);
  if (g_paramsUpdatedAt.length() > 0) {
    body += ",\"params_updated_at\":\"" + g_paramsUpdatedAt + "\"";
  }
  body += "}";

  String resp;
  int code = 0;
  if (!httpPostJson(g_cfg.apiUrl, body, &resp, &code)) {
    Serial.printf("[TX] POST %d\n", code);
    return;
  }
  Serial.printf("[TX] POST %d\n", code);

  pushFlash(FP_ENVIADO);

  StaticJsonDocument<384> rx;
  if (deserializeJson(rx, resp) == DeserializationError::Ok) {
    const char *pu = rx["params_updated_at"] | "";
    if (pu[0] && g_paramsUpdatedAt != pu) g_pullNowRequested = true;
    if (rx["pull_params_now"] | false) g_pullNowRequested = true;
  }
}

static void requestImmediateTx() {
  g_immediateTxRequested = true;
}

static void checkTelemetryTriggers() {
  if (compresor != prevCompresor) {
    requestImmediateTx();
    prevCompresor = compresor;
  }
  if (P.F24 >= 0.5f) {
    if (ventilador != prevVentilador || deshielo != prevDeshielo) {
      requestImmediateTx();
    }
  }
  prevVentilador = ventilador;
  prevDeshielo = deshielo;

  if (!fault1 && P.F23 > 0.0f && prevTempReported > -100.0f) {
    if (fabsf(tCam - prevTempReported) >= P.F23) requestImmediateTx();
  }
  if (!fault1 && prevTempReported <= -100.0f) prevTempReported = tCam;
  else if (!fault1) prevTempReported = tCam;
}

static void leerSerial() {
  if (!Serial.available()) return;
  String s = Serial.readStringUntil('\n');
  s.trim();
  String lower = s;
  lower.toLowerCase();
  if (lower == "portal" || lower == "wifi") runConfigPortal();
  else if (lower == "pull") g_pullNowRequested = true;
  else if (lower == "config") {
    Serial.printf("module=%s sp=%.1f diff=%.1f F09=%.0f F22=%.0f\n",
                  g_cfg.moduleId, P.F01, P.F05, P.F09, P.F22);
  } else if (lower == "off") {
    compresor = ventilador = deshielo = false;
    dripping = false;
    flashUiMessage("OFF ", 900);
  } else if (lower == "defrost" || lower == "deshielo") {
    g_serialForceDefrost = true;
    Serial.println(F("[SERIE] Deshielo en proximo tick"));
  } else if (s.length() > 0) {
    flashUiMessage(s.c_str(), 1200);
  }
}

static void serviceNetwork(unsigned long now) {
  if (g_portalRunning) return;
  if (WiFi.status() == WL_CONNECTED) {
    if (!g_prevWifiConnected) {
      g_prevWifiConnected = true;
      pushFlash(FP_WIFI);
    }
    bool sendNow = false;
    unsigned long telEvery = g_cfg.intervalMs;
    if (!fault1 && tCam >= CAMBIENT_HOT_C) telEvery = max(telEvery, 120000UL);
    if (now - g_lastTel >= telEvery) sendNow = true;
    if (g_immediateTxRequested) {
      const bool gapOk = (g_lastImmediateTxAt == 0) ||
                         (now - g_lastImmediateTxAt >= IMMEDIATE_TX_MIN_GAP_MS);
      if (gapOk) {
        sendNow = true;
        g_immediateTxRequested = false;
        g_lastImmediateTxAt = now;
      }
    }
    if (sendNow) {
      g_lastTel = now;
      enviarTelemetria();
    }
    if (g_pullNowRequested || now - g_lastPull >= PARAMS_PULL_MS) {
      g_lastPull = now;
      g_pullNowRequested = false;
      pullParamsFromCloud();
    }
  } else {
    g_prevWifiConnected = false;
    if (g_lastWifiRetry == 0 || now - g_lastWifiRetry >= 30000UL) {
      g_lastWifiRetry = now;
      WiFi.disconnect();
      WiFi.begin();
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(STROBE_PIN, OUTPUT);
  digitalWrite(STROBE_PIN, LOW);
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
  pinMode(BTN_UP_PIN, INPUT_PULLUP);
  pinMode(BTN_DOWN_PIN, INPUT_PULLUP);
  pinMode(BTN_SET_PIN, INPUT_PULLUP);
  pinMode(BTN_BACK_PIN, INPUT_PULLUP);
  if (DOOR_PIN >= 0) pinMode(DOOR_PIN, INPUT_PULLUP);
  syncBtnPrevFromPins();

  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  enviar4094(comunesApagados(), 0xFF);

  Serial.println(F("AR Monitoreo PRO400 ESP8266 booteando..."));
  ensureFs();
  loadConfig();
  loadParams();
  syncTelemetryInterval();

  bootAtMs = millis();
  unsigned long holdMs = (unsigned long)(P.F13 * 60.0f * 1000.0f);
  if (holdMs < RELAY_BOOT_MIN_MS) holdMs = RELAY_BOOT_MIN_MS;
  relaySafeUntilMs = bootAtMs + holdMs;
  if (P.F19 > 0.0f) keysLockUntilMs = bootAtMs + (unsigned long)(P.F19 * 1000.0f);

  bootDelayDone = false;
  defrostOnStartDone = false;
  firstCompCycleDone = false;
  emergencyChangedAt = bootAtMs;
  compChangedAt = bootAtMs;
  lastDefrostEndAt = bootAtMs;

  texto = "BOOT";
  prepararTexto();

  setupWifi();
  if (!g_portalRunning && g_uiMode == UI_NORMAL) modoTexto = false;
}

void loop() {
  yield();
  if (millis() - g_lastDisplayRefresh >= 2) {
    g_lastDisplayRefresh = millis();
    refrescarDisplay();
  }
  leerSerial();
  leerPuerta();
  handleButtonUi();
  serviceUiFlash(millis());

  if (millis() - lastReadAt >= 1000) {
    lastReadAt = millis();
    bool raw = false;
    const float rawT = leerNTCRaw(raw);
    applyEma(rawT);
    updateFault(raw);
    aplicarControl();
    checkTelemetryTriggers();
    aplicarDeratingCalor(millis());
  }

  if (g_uiMode == UI_PARAM_SELECT) {
    showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
  } else if (g_uiMode == UI_PARAM_EDIT) {
    mostrarTemperatura(*g_paramMenu[g_paramCursor].value);
  } else if (!modoTexto && !g_flashActive && millis() - lastDisplaySwitchAt >= 1000) {
    lastDisplaySwitchAt = millis();
    refreshNormalDisplay();
  }

  serviceNetwork(millis());
}
