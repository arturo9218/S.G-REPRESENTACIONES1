/**
 * S.G Representación — Plaqueta "Mini PRO300 con control" (ESP32 + 2x CD4094)
 * ----------------------------------------------------------------------------
 *
 * Hardware (deducido del prototipo del usuario):
 *   - ESP32 (DOIT DevKit / NodeMCU-32S)
 *   - 2 NTC 10k beta 3950: NTC1 GPIO34 (cámara), NTC2 GPIO35 (evaporador).
 *     Divisor a 3.3V con R_fixed=10k (NTC arriba, R a GND).
 *   - 2x CD4094 en cascada via SPI:
 *       4094 #1 = byte de SEGMENTOS (a,b,c,d,e,f,g,dp) — display 7-seg común ánodo (activo LOW)
 *       4094 #2 = bit 0..4 = COM1..COM5 (4 dígitos + fila de 3 luces)
 *                 bit 5    = relay COMPRESOR  (activo LOW)
 *                 bit 6    = relay DESHIELO   (activo LOW)
 *                 bit 7    = relay VENTILADOR (activo LOW)
 *   - Pines SPI hacia los 4094:  DATA=23 (MOSI), CLOCK=18 (SCK), STROBE=5 (latch)
 *
 * Qué hace:
 *   - Lee 2 NTC con promedio y detecta sonda abierta/corto (muestra "E1"/"E2").
 *   - Termostato con histéresis + tiempos mínimos del compresor (anti-cortocircuito).
 *   - Deshielo programado por tiempo (cada N horas) + drenaje (drip).
 *   - Multiplexado de 4 dígitos + fila de 3 LEDs de estado, sin parpadeo.
 *   - Comandos por puerto serie para configurar y forzar modos.
 *   - WiFi + POST cada 30 s a la Edge Function `ingest-reading` de Supabase.
 *   - Persistencia de configuración en NVS (Preferences).
 *   - Watchdog de tarea (15 s) para reinicio ante cuelgues.
 *
 * En la app:
 *   Esta plaqueta se da de alta como **PRO300** (2 sondas).
 *   Después de la migración 043_device_readings_relays.sql + redeploy de
 *   `ingest-reading`, además guarda en la base `comp_on / fan_on / defrost_on`
 *   por lectura. La UI mostrará esos estados en la próxima fase.
 *   Si querés ver YA los relés en la app (UI vieja de combistato), cambiar
 *   `KIND_COMBISTATO` a `true` y dar de alta el equipo como combistato.
 *
 * Provisionado (una sola vez por placa, por el Monitor Serie a 115200 baud):
 *
 *     setssid  <NOMBRE_WIFI>
 *     setpass  <PASSWORD_WIFI>
 *     setid    <moduleId del modal de alta>
 *     settoken <deviceToken del modal de alta>
 *     seturl   <ingestUrl del modal de alta>
 *     setpoint -18
 *     hist     2
 *     config             ← verifica lo guardado
 *     reboot             ← aplica WiFi
 *
 *  Comandos manuales útiles:
 *     temp              → vuelve a mostrar temperatura
 *     off               → apaga compresor/vent/deshielo, muestra "OFF"
 *     defrost           → fuerza ciclo de deshielo ahora
 *     <cualquier texto> → marquesina en el display
 *
 *  Dependencias:
 *     Arduino core ESP32 (Espressif). Sin librerías externas: usa WiFi,
 *     HTTPClient, Preferences, esp_task_wdt, SPI (todas vienen con el core).
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <SPI.h>
#include <math.h>

// ============== MODO EN LA APP ==============
// false → se registra como dispositivo PRO300 (la app muestra T1, T2; los relés se
//         guardan en device_readings pero la UI los muestra en una fase futura).
// true  → se registra como combistato (la UI ya muestra comp/vent/deshielo).
#define KIND_COMBISTATO false

// ============== PINES =======================
#define DATA_PIN   23
#define CLOCK_PIN  18
#define STROBE_PIN 5
#define NTC1_PIN   34   // sonda cámara
#define NTC2_PIN   35   // sonda evaporador

// ============== NTC =========================
static constexpr float R_FIXED = 10000.0f;
static constexpr float BETA    = 3950.0f;
static constexpr float T0K     = 298.15f;
static constexpr float R0      = 10000.0f;
static constexpr float TEMP_ERR_VALUE = -127.0f;

// ============== LAYOUT 4094 #2 ==============
#define BIT_COM1 0
#define BIT_COM2 1
#define BIT_COM3 2
#define BIT_COM4 3
#define BIT_COM5 4
#define BIT_COMP 5
#define BIT_DEF  6
#define BIT_FAN  7

// ============== CONFIG DE CONTROL ===========
struct Cfg {
  float    setC          = -18.0f;          // setpoint cámara
  float    histC         = 2.0f;            // diferencial (enciende a set+hist, apaga a set)
  uint32_t compMinOnMs   = 60UL * 1000;     // 1 min mínimo encendido
  uint32_t compMinOffMs  = 180UL * 1000;    // 3 min mínimo apagado (anti-cortocircuito)
  uint32_t defEverySec   = 6UL * 3600;      // deshielo cada 6 h
  uint32_t defDurMs      = 20UL * 60 * 1000; // 20 min duración deshielo
  uint32_t dripMs        = 90UL * 1000;     // 90 s drenaje post-deshielo (fan off)
  uint32_t telemetryMs   = 30UL * 1000;     // POST a Supabase cada 30 s
};
Cfg cfg;

// ============== ESTADO ======================
static bool compresor = false, ventilador = false, deshielo = false, dripping = false;
static unsigned long compChangedAt = 0;
static unsigned long defStartedAt  = 0;
static unsigned long dripStartedAt = 0;
static unsigned long lastDefrostAt = 0;
static unsigned long lastTelemetryAt = 0;
static unsigned long lastReadAt = 0;
static unsigned long lastDisplaySwitchAt = 0;
static bool showSensorCam = true;

static float tCam  = TEMP_ERR_VALUE;
static float tEvap = TEMP_ERR_VALUE;
static bool  fault1 = true, fault2 = true;

static bool   modoTexto = true;
static String texto = "INIT";
static int    scrollPos = 0;

static byte bufferDisplay[4] = {0xFF, 0xFF, 0xFF, 0xFF};
static int  digitNow = 0;
static unsigned long lastRefresh = 0, lastScroll = 0;

// ============== NVS =========================
Preferences prefs;
String wifiSsid, wifiPass, moduleId, deviceToken, ingestUrl;

// ============== TABLAS 7-seg ================
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
    case 'I': return 0b11111001; case 'J': return 0b11100001;
    case 'L': return 0b11000111; case 'N': return 0b10101011;
    case 'O': return 0b11000000; case 'P': return 0b10001100;
    case 'R': return 0b10101111; case 'S': return 0b10010010;
    case 'T': return 0b10000111; case 'U': return 0b11000001;
    case 'Y': return 0b10010001;
    case '-': return MENOS;      case ' ': return BLANCO;
    default:  return BLANCO;
  }
}

// ============== HELPERS 4094 ================
static byte relayMask() {
  byte b = 0;
  if (compresor)  b |= (1 << BIT_COMP);
  if (deshielo)   b |= (1 << BIT_DEF);
  if (ventilador) b |= (1 << BIT_FAN);
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
  // Apaga todos los comunes antes de cambiar de dígito (evita ghosting).
  enviar4094(comunesApagados(), 0xFF);

  if (digitNow < 4) {
    enviar4094(activarCom(digitNow), bufferDisplay[digitNow]);
  } else {
    byte luces = 0xFF;
    if (compresor)  luces &= ~(1 << 0);
    if (ventilador) luces &= ~(1 << 1);
    if (deshielo)   luces &= ~(1 << 2);
    enviar4094(activarCom(BIT_COM5), luces);
  }
  if (++digitNow > 4) digitNow = 0;
}

// ============== DISPLAY: TEXTO Y TEMP =======
static String adaptarTexto(String t) {
  t.toUpperCase();
  t.replace("M", "N");  // la M no se forma bien en 7-seg
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
  int valor  = (int)round(temp * 10);
  int entero = valor / 10;
  int dec    = valor % 10;
  if (neg && entero < 10) {
    bufferDisplay[0] = MENOS;
    bufferDisplay[1] = num7seg[entero] & 0b01111111;  // enciende DP
    bufferDisplay[2] = num7seg[dec];
  } else if (neg) {
    bufferDisplay[0] = MENOS;
    bufferDisplay[1] = num7seg[(entero / 10) % 10];
    bufferDisplay[2] = num7seg[entero % 10];
  } else if (entero < 10) {
    bufferDisplay[1] = num7seg[entero] & 0b01111111;
    bufferDisplay[2] = num7seg[dec];
  } else {
    bufferDisplay[0] = num7seg[entero / 10];
    bufferDisplay[1] = num7seg[entero % 10] & 0b01111111;
    bufferDisplay[2] = num7seg[dec];
  }
}

static void mostrarError(int idx) {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bufferDisplay[1] = mapaChar('E');
  bufferDisplay[2] = num7seg[idx];
}

// ============== LECTURA NTC =================
static float leerNTCpromedio(int pin, bool &fault) {
  long acc = 0;
  int validas = 0;
  for (int i = 0; i < 16; i++) {
    int v = analogRead(pin);
    if (v > 5 && v < 4090) { acc += v; validas++; }
    delayMicroseconds(200);
  }
  if (validas < 8) { fault = true; return TEMP_ERR_VALUE; }
  int adc = acc / validas;
  float rNTC = R_FIXED * ((float)adc / (4095.0f - (float)adc));
  float tK = 1.0f / ((1.0f / T0K) + (1.0f / BETA) * log(rNTC / R0));
  float tC = tK - 273.15f;
  if (tC < -45.0f || tC > 80.0f) { fault = true; return TEMP_ERR_VALUE; }
  fault = false;
  return tC;
}

// ============== CONTROL =====================
static void aplicarControl() {
  unsigned long now = millis();

  // Sin sonda cámara → modo seguro: apagar todo.
  if (fault1) {
    if (compresor) { compresor = false; compChangedAt = now; }
    ventilador = false;
    return;
  }

  // Inicio de deshielo programado (no pisar uno en curso, ni en drenaje).
  if (!deshielo && !dripping && (now - lastDefrostAt) >= (cfg.defEverySec * 1000UL)) {
    deshielo = true;
    defStartedAt = now;
    if (compresor) { compresor = false; compChangedAt = now; }
    ventilador = false;
    return;
  }

  // En deshielo: termina por tiempo o por sonda evaporador alta.
  if (deshielo) {
    bool finPorTemp = !fault2 && tEvap >= 10.0f;
    if ((now - defStartedAt) >= cfg.defDurMs || finPorTemp) {
      deshielo = false;
      lastDefrostAt = now;
      dripping = true;
      dripStartedAt = now;
    }
    return;
  }

  // Drenaje: ventilador apagado para no soplar agua.
  if (dripping) {
    ventilador = false;
    if ((now - dripStartedAt) >= cfg.dripMs) {
      dripping = false;
    } else {
      return;
    }
  }

  // Termostato con histéresis y tiempos mínimos.
  float onAt  = cfg.setC + cfg.histC;
  float offAt = cfg.setC;

  if (compresor) {
    if ((now - compChangedAt) >= cfg.compMinOnMs && tCam <= offAt) {
      compresor = false;
      compChangedAt = now;
    }
  } else {
    if ((now - compChangedAt) >= cfg.compMinOffMs && tCam >= onAt) {
      compresor = true;
      compChangedAt = now;
    }
  }

  // Ventilador encadenado al compresor (típico cámara).
  ventilador = compresor;
}

// ============== WiFi + TELEMETRÍA ===========
static void wifiConectar() {
  if (wifiSsid.length() == 0) return;
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  Serial.print("WiFi -> "); Serial.println(wifiSsid);
}

static void enviarTelemetria() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (moduleId.length() == 0 || deviceToken.length() == 0 || ingestUrl.length() == 0) return;

  HTTPClient http;
  http.begin(ingestUrl);
  http.addHeader("Content-Type", "application/json");

  String body = "{";
  body += "\"moduleId\":\"" + moduleId + "\",";
  body += "\"deviceToken\":\"" + deviceToken + "\",";

  if (!fault1) body += "\"temp1_c\":" + String(tCam, 2)  + ",";
  else         body += "\"temp1_c\":null,";

  if (!fault2) body += "\"temp2_c\":" + String(tEvap, 2);
  else         body += "\"temp2_c\":null";

  // Estado de relés (PRO300 con control / combistato).
  body += ",\"comp_on\":"    + String(compresor  ? "true" : "false");
  body += ",\"fan_on\":"     + String(ventilador ? "true" : "false");
  body += ",\"defrost_on\":" + String(deshielo   ? "true" : "false");

  body += "}";

  int code = http.POST(body);
  Serial.print("POST "); Serial.print(code);
  if (code > 0) { Serial.print(" "); Serial.println(http.getString()); }
  else          { Serial.println(); }
  http.end();
}

// ============== COMANDOS SERIE ==============
static void leerSerial() {
  if (!Serial.available()) return;
  String dato = Serial.readStringUntil('\n');
  dato.trim();
  if (dato.length() == 0) return;

  if (dato.startsWith("setssid "))  { wifiSsid    = dato.substring(8);  prefs.putString("ssid",  wifiSsid);    Serial.println("OK"); return; }
  if (dato.startsWith("setpass "))  { wifiPass    = dato.substring(8);  prefs.putString("pass",  wifiPass);    Serial.println("OK"); return; }
  if (dato.startsWith("setid "))    { moduleId    = dato.substring(6);  prefs.putString("modid", moduleId);    Serial.println("OK"); return; }
  if (dato.startsWith("settoken ")) { deviceToken = dato.substring(9);  prefs.putString("tok",   deviceToken); Serial.println("OK"); return; }
  if (dato.startsWith("seturl "))   { ingestUrl   = dato.substring(7);  prefs.putString("url",   ingestUrl);   Serial.println("OK"); return; }
  if (dato.startsWith("setpoint ")) { cfg.setC    = dato.substring(9).toFloat();  prefs.putFloat("set",  cfg.setC);  Serial.println("OK"); return; }
  if (dato.startsWith("hist "))     { cfg.histC   = dato.substring(5).toFloat();  prefs.putFloat("hist", cfg.histC); Serial.println("OK"); return; }

  if (dato == "config") {
    Serial.printf("SSID=%s\nID=%s\nTOK=%s\nURL=%s\nSET=%.1f HIST=%.1f\n",
      wifiSsid.c_str(), moduleId.c_str(), deviceToken.c_str(),
      ingestUrl.c_str(), cfg.setC, cfg.histC);
    return;
  }
  if (dato == "reboot")                          { ESP.restart(); }
  if (dato == "defrost" || dato == "deshielo")   { lastDefrostAt = 0; Serial.println("Forzando deshielo"); return; }
  if (dato == "temp")                            { modoTexto = false; return; }
  if (dato == "off") {
    compresor = ventilador = deshielo = false;
    modoTexto = true; texto = "OFF"; scrollPos = 0; prepararTexto();
    return;
  }

  // Texto libre → marquesina.
  modoTexto = true;
  texto = dato;
  scrollPos = 0;
  prepararTexto();
}

// ============== SETUP / LOOP ================
void setup() {
  Serial.begin(115200);
  pinMode(STROBE_PIN, OUTPUT);
  digitalWrite(STROBE_PIN, LOW);
  analogReadResolution(12);

  SPI.begin(CLOCK_PIN, -1, DATA_PIN, -1);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  enviar4094(comunesApagados(), 0xFF);

  prefs.begin("sg", false);
  wifiSsid    = prefs.getString("ssid",  "");
  wifiPass    = prefs.getString("pass",  "");
  moduleId    = prefs.getString("modid", "");
  deviceToken = prefs.getString("tok",   "");
  ingestUrl   = prefs.getString("url",   "");
  cfg.setC    = prefs.getFloat("set",  cfg.setC);
  cfg.histC   = prefs.getFloat("hist", cfg.histC);

  esp_task_wdt_init(15, true);
  esp_task_wdt_add(NULL);

  texto = "INIT";
  prepararTexto();

  Serial.println();
  Serial.println("S.G PRO300 booteado.");
  Serial.println("Comandos: setssid / setpass / setid / settoken / seturl / setpoint / hist / config / reboot / temp / off / defrost");

  wifiConectar();
}

void loop() {
  esp_task_wdt_reset();
  leerSerial();

  // Refresh display: 5 dígitos a ~400 Hz cada uno.
  if (micros() - lastRefresh >= 500) {
    lastRefresh = micros();
    refrescarDisplay();
  }

  // Lectura NTC + control cada 1 s.
  if (millis() - lastReadAt >= 1000) {
    lastReadAt = millis();
    tCam  = leerNTCpromedio(NTC1_PIN, fault1);
    tEvap = leerNTCpromedio(NTC2_PIN, fault2);
    aplicarControl();
  }

  // Alternar T1 / T2 cada 3 s (o error en su lugar).
  if (!modoTexto && millis() - lastDisplaySwitchAt >= 3000) {
    lastDisplaySwitchAt = millis();
    if (showSensorCam) { fault1 ? mostrarError(1) : mostrarTemperatura(tCam); }
    else               { fault2 ? mostrarError(2) : mostrarTemperatura(tEvap); }
    showSensorCam = !showSensorCam;
  }

  // Scroll de marquesina.
  if (modoTexto && millis() - lastScroll >= 300) {
    lastScroll = millis();
    prepararTexto();
  }

  // Keepalive WiFi.
  if (WiFi.status() != WL_CONNECTED) wifiConectar();

  // Telemetría.
  if (millis() - lastTelemetryAt >= cfg.telemetryMs) {
    lastTelemetryAt = millis();
    enviarTelemetria();
  }

  (void)KIND_COMBISTATO;  // reservado para diferenciar payload en futuras versiones
}
