/**
 * S.G Representación — Plaqueta "PRO300 con control" (ESP32 + 2x CD4094)
 * ----------------------------------------------------------------------
 * Fase B: el ESP32 baja los 48 parámetros AR01–AR48 desde Supabase
 *         (Edge Function `fetch-pro300-params`, tabla `combistatos.params`).
 *
 * Hardware:
 *   - ESP32 (DOIT DevKit / NodeMCU-32S).
 *   - 2 NTC 10k beta 3950: NTC1 GPIO34 (cámara/ambiente), NTC2 GPIO35 (evaporador).
 *     Divisor a 3.3V con R_fixed=10k (NTC arriba, R a GND).
 *   - 2x CD4094 en cascada por SPI:
 *       4094 #1 = byte SEGMENTOS (a..g + dp), 7-seg activo en LOW.
 *       4094 #2 = bit 0..4 COM1..COM5 (4 dígitos + fila luces)
 *                 bit 5 RELAY COMPRESOR  (activo LOW)
 *                 bit 6 RELAY DESHIELO   (activo LOW)
 *                 bit 7 RELAY VENTILADOR (activo LOW)
 *   - SPI:  DATA=23 (MOSI), CLOCK=18 (SCK), STROBE=5 (latch).
 *   - DOOR_PIN: opcional. Si tu plaqueta tiene microswitch de puerta cableado
 *               a un GPIO, cambiá `DOOR_PIN` y se activa toda la lógica AR35–AR41.
 *               Con -1 (default) los parámetros se guardan pero no se accionan.
 *
 * Provisión: portal cautivo WiFiManager con campos para Supabase.
 *   1) Primer arranque (sin config) → AP "PRO300-Setup" abierto por 5 min.
 *   2) GPIO0 (botón BOOT) a GND al energizar → fuerza portal.
 *   3) Comando serie `portal` → abre portal en caliente.
 *
 *   Campos del portal:
 *     - WiFi SSID / Pass         (lo pone WiFiManager solo)
 *     - module_id                (alta del PRO300 en la app S.G)
 *     - api_key                  (token de 6 dígitos del alta)
 *     - api_url                  (https://<proyecto>.functions.supabase.co/functions/v1/ingest-reading)
 *
 *   Todo se guarda en LittleFS:
 *     - `/config.json` → credenciales + URL ingest (raro que cambien)
 *     - `/params.json` → últimos AR01–AR48 sincronizados desde la nube
 *
 * Comandos por puerto serie (115200, Newline):
 *     portal         → re-abre portal cautivo
 *     reset          → borra config y reinicia (vuelve a primer arranque)
 *     config         → muestra config + parámetros AR vigentes
 *     pull           → fuerza un pull de AR desde la nube
 *     temp           → display en modo temperatura
 *     off            → apaga compresor/vent/deshielo y muestra "OFF"
 *     defrost        → fuerza un ciclo de deshielo ahora
 *     <texto libre>  → marquesina en el display
 *
 * Dependencias (Arduino Library Manager):
 *   - WiFiManager   (tzapu)
 *   - ArduinoJson   (Benoit Blanchon, v6)
 *   El resto (WiFi, HTTPClient, LittleFS, esp_task_wdt, SPI) viene con el core ESP32.
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <SPI.h>
#include <math.h>

// ============== PINES =======================
#define DATA_PIN          23
#define CLOCK_PIN         18
#define STROBE_PIN        5
#define NTC1_PIN          34   // sonda cámara / ambiente
#define NTC2_PIN          35   // sonda evaporador
#define PIN_FORCE_PORTAL  0    // BOOT button: a GND al arranque → fuerza portal
#define DOOR_PIN         -1    // -1 = sin sensor de puerta; cambialo a un GPIO si lo cableaste

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

// ============== CONFIG ======================
static constexpr const char *CFG_PATH       = "/config.json";
static constexpr const char *PARAMS_PATH    = "/params.json";
static constexpr const char *AP_NAME        = "PRO300-Setup";
static constexpr unsigned long PORTAL_TIMEOUT_SEC   = 5UL * 60UL;
static constexpr unsigned long WIFI_BOOT_CONNECT_MS = 20000UL;
// 60 s reduce a la mitad la carga de inserts en `device_readings`/`combistato_readings`
// y mantiene el Free tier de Supabase con aire. La temperatura de cámara cambia en
// minutos, no en segundos, así que 1 punto/min sigue siendo de sobra para gráficos.
static constexpr unsigned long TELEMETRY_DEFAULT_MS = 60000UL;
/** Pull AR + pending_command: 60 s en reposo; 10 s tras comando o params nuevos (2 min). */
static constexpr unsigned long PARAMS_PULL_MS_NORMAL = 60UL * 1000UL;
static constexpr unsigned long PARAMS_PULL_MS_FAST   = 10UL * 1000UL;
static constexpr unsigned long PULL_FAST_WINDOW_MS     = 2UL * 60UL * 1000UL;
/** Si |ΔT| de la sonda de control supera esto, TX inmediato (Fase 1 smart delta). */
static constexpr float TEMP_DELTA_TX_C = 0.3f;

struct Cfg {
  char apiUrl[200]   = "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading";
  char moduleId[64]  = "";
  char apiKey[48]    = "";
  uint32_t intervalMs = TELEMETRY_DEFAULT_MS;
} g_cfg;

/**
 * Parámetros AR01–AR48 (claves F01–F55 + F52t alineadas con la app `combistato-params.defaults.ts`).
 * Defaults idénticos a la app: si el dispositivo arranca sin /params.json y no logra contactar
 * con la nube todavía, queda con los mismos valores que muestra el formulario en la UI.
 */
struct Params {
  // Termostato
  float F01 = -18.0f;   // AR01 setpoint °C
  float F02 = 3.0f;     // AR02 histéresis °C
  float F03 = 0.0f;     // AR03 corrección S1 (sumar al leído)
  float F04 = 0.0f;     // AR04 corrección S2
  float F49 = 0.0f;     // AR05 modo: 0=frío, 1=calor
  float F50 = 0.0f;     // AR06 inversión de relés: 0=activo LOW (default), 1=activo HIGH
  float F53 = 0.0f;     // AR07 sonda que controla termostato: 0=S1, 1=S2
  float F54 = 4.0f;     // AR08 muestras promedio ADC (4–32)

  // Deshielo
  float F05 = 0.0f;     // AR09 tipo de deshielo (0=eléctrico)
  float F06 = 360.0f;   // AR10 intervalo entre deshielos (min)
  float F07 = 30.0f;    // AR11 tiempo máx deshielo (min)
  float F08 = 8.0f;     // AR12 temp fin deshielo (S2, °C)
  float F09 = 0.0f;     // AR13 deshielo al encender (0/1)
  float F38 = 30.0f;    // AR14 retardo al encender (s)
  float F39 = 3.0f;     // AR15 tiempo de goteo (min)
  float F45 = 10.0f;    // AR16 bloqueo deshielo desde encendido (min)
  float F46 = 1440.0f;  // AR17 máx sin deshielo → forzar (min)
  float F52 = 0.0f;     // AR18 habilitar deshielo por temperatura (0/1)
  float F52t = -28.0f;  // AR19 umbral de hielo en evaporador (°C)

  // Ventilador
  float F10 = 0.0f;     // AR20 ventilador durante deshielo (0/1)
  float F11 = 2.0f;     // AR21 retardo vent post-deshielo (min)
  float F12 = -5.0f;    // AR22 temp evap para arrancar vent post-deshielo (°C)
  float F51 = 0.0f;     // AR23 ventilador continuo (0=solo con compresor, 1=siempre)

  // Alarmas
  float F13 = 10.0f;    // AR24 alarma temp alta (°C)
  float F14 = -30.0f;   // AR25 alarma temp baja (°C)
  float F15 = 5.0f;     // AR26 retardo alarma térmica (min)
  float F16 = 1.0f;     // AR27 alarma por sonda falla (0/1)
  float F47 = 1.0f;     // AR28 histéresis de alarma (°C)
  float F48 = 5.0f;     // AR29 retardo alarmas al encender (min)

  // Compresor (tiempos de protección)
  float F17 = 60.0f;    // AR30 tmin OFF compresor (s)
  float F18 = 30.0f;    // AR31 tmin ON compresor  (s)
  float F19 = 300.0f;   // AR32 emergencia ON  (s, con sonda fallada)
  float F20 = 300.0f;   // AR33 emergencia OFF (s, con sonda fallada)
  float F55 = 1.0f;     // AR34 acción ante falla de sonda (0=apaga / 1=emergencia)

  // Puerta (requiere hardware DOOR_PIN configurado)
  float F25 = 0.0f;     // AR35 habilitar entrada de puerta (0/1)
  float F26 = 1.0f;     // AR36 contacto puerta (0=NC, 1=NO)
  float F27 = 120.0f;   // AR37 retardo alarma puerta abierta (s)
  float F28 = 1.0f;     // AR38 apagar vent con puerta abierta
  float F29 = 0.0f;     // AR39 bloquear alarmas térmicas con puerta abierta
  float F30 = 0.0f;     // AR40 registrar evento puerta por Serial
  float F40 = 0.0f;     // AR41 apagar compresor con puerta abierta

  // Comandos manuales por serie (los gestiona leerSerial)
  float F31 = 0.0f;     // AR42 permitir compresor manual por Serial
  float F32 = 30.0f;    // AR43 tiempo máx compresor manual (min)
  float F33 = 0.0f;     // AR44 permitir ventilador manual por Serial
  float F34 = 30.0f;    // AR45 tiempo máx ventilador manual (min)
  float F35 = 0.0f;     // AR46 permitir deshielo manual por Serial
  float F36 = 30.0f;    // AR47 tiempo mínimo entre deshielos manuales (min)
  float F37 = 0.0f;     // AR48 deshielo inmediato cuando se pide (0/1)
} P;

static String g_paramsUpdatedAt = "";    // marca devuelta por la nube; permite saber cuándo cambió

// ============== ESTADO ======================
enum WifiState { WFS_BOOT, WFS_PORTAL, WFS_RUNNING };
static WifiState g_wifiState = WFS_BOOT;

// Fase actual del controlador (se reporta en cada telemetría para que la app
// muestre Transcurrido/Faltan/etc. en la card. Pasa por cada bloque del loop
// de control y se cambia con setPhase()).
enum Phase { PH_OFF, PH_BOOT, PH_NORMAL, PH_DEFROST, PH_DRIP, PH_POST_DEFROST, PH_EMERG };
static Phase g_phase = PH_BOOT;
static unsigned long g_phaseStartedAt = 0;
static uint32_t g_phaseTotalS = 0;

static const char *phaseName(Phase p) {
  switch (p) {
    case PH_OFF:           return "off";
    case PH_BOOT:          return "boot";
    case PH_NORMAL:        return "normal";
    case PH_DEFROST:       return "defrost";
    case PH_DRIP:          return "drip";
    case PH_POST_DEFROST:  return "post_defrost";
    case PH_EMERG:         return "emerg";
  }
  return "normal";
}

static void setPhase(Phase p, uint32_t totalS) {
  if (g_phase == p) {
    // Misma fase: solo refrescamos `phase_total_s` por si un parámetro AR
    // cambió desde la nube (p.ej. AR10 / F06 mientras estamos refrigerando).
    // El cronómetro de inicio se preserva para no resetear el "Transcurrido".
    g_phaseTotalS = totalS;
    return;
  }
  g_phase = p;
  g_phaseStartedAt = millis();
  g_phaseTotalS = totalS;
}

static bool compresor=false, ventilador=false, deshielo=false, dripping=false;
static unsigned long compChangedAt=0, defStartedAt=0, dripStartedAt=0;
static unsigned long lastDefrostAt=0, lastReadAt=0;
static unsigned long lastDisplaySwitchAt=0, bootAtMs=0;
static bool   bootDelayDone = false;   // F38 retardo al encender consumido
static bool   defrostOnStartDone = false; // F09: ya disparado el deshielo de arranque

// Alarmas locales (espejo de lo que también podría calcular el backend)
static bool   alarmHigh=false, alarmLow=false, alarmProbe=false;
static unsigned long alarmHighSinceMs=0, alarmLowSinceMs=0;

// Puerta (solo activo si DOOR_PIN != -1)
static bool  doorOpen=false;
static unsigned long doorChangedAt=0;
static bool  doorAlarm=false;

// Emergencia (sonda fallada, F19/F20)
static unsigned long emergencyChangedAt=0;
static bool          emergencyComp=false;

// ============== Overrides manuales (comandos desde la app) ==============
// La app puede forzar el compresor/ventilador por 10 min, o disparar/cancelar
// un deshielo. El comando viene en la respuesta de fetch-pro300-params con un
// `ts` único; lo aplicamos una sola vez y persistimos el `ts` en LittleFS
// para no reaplicarlo tras un reboot.
struct ManualOverride {
  bool          compActive  = false;
  bool          compValue   = false;
  unsigned long compEndsAt  = 0;
  bool          fanActive   = false;
  bool          fanValue    = false;
  unsigned long fanEndsAt   = 0;
};
static ManualOverride OV;
static bool          g_manualDefrostRequested = false;
static bool          g_manualCancelDefrost    = false;
static String        g_lastCmdTs              = "";
static unsigned long g_lastManualDefrostAt    = 0;  // anti-spam F36

static float tCam  = TEMP_ERR_VALUE;
static float tEvap = TEMP_ERR_VALUE;
static bool  fault1=true, fault2=true;

static bool   modoTexto = true;
static String texto = "BOOT";
static int    scrollPos = 0;

static byte bufferDisplay[4] = {0xFF, 0xFF, 0xFF, 0xFF};
static int  digitNow = 0;
static unsigned long lastScroll=0;

// Task dedicada a HTTP (telemetría + pull). Corre en core 0 para no bloquear
// la multiplexación del display (que está en el loopTask = core 1).
static TaskHandle_t g_netTaskHandle = NULL;
// Task dedicada exclusivamente al refresco multiplexado del 7-seg. Corre en
// core 1 con prioridad mayor que el loopTask, así ningún cálculo / log /
// portal / NTC le roba ciclos al display (causa principal de parpadeo).
static TaskHandle_t g_displayTaskHandle = NULL;
static bool          g_pullNowRequested = false;   // pedido desde serie / params_updated_at
static unsigned long g_pullFastUntilMs  = 0;     // ventana de pull rápido (botones / AR)
// Banderas seteadas desde la network task (core 0) y leídas por el loop (core 1)
// para mostrar un scroll efímero en el display cuando se envió/actualizó.
static volatile bool g_flashTelemetrySent = false;
static volatile bool g_flashParamsUpdated = false;
static bool          g_flashActive        = false;
static unsigned long g_flashEndsAt        = 0;

// ============== Event-driven telemetry ======
// Aparte del ciclo periódico de g_cfg.intervalMs (60 s por default), disparamos
// un TX inmediato cuando cambia el estado de un relé, la fase o la puerta. Eso
// mantiene la app "en tiempo real" para eventos importantes sin inflar la
// cuota de inserts en Supabase (los eventos son raros vs telemetría continua).
// Un rate-limit anti-bounce de 5 s evita tormentas si un relé chattea.
static volatile bool           g_immediateTxRequested = false;
static unsigned long           g_lastImmediateTxAt    = 0;
static constexpr unsigned long IMMEDIATE_TX_MIN_GAP_MS = 5000UL;

// Snapshot del estado previo para detectar transiciones (se actualiza tras
// cada aplicarControl()+applyManualOverride() en el loop).
static bool  prevCompresor  = false;
static bool  prevVentilador = false;
static bool  prevDeshielo   = false;
static bool  prevDripping   = false;
static bool  prevDoorOpen   = false;
static Phase prevPhase      = PH_BOOT;
/** Última temp reportada en TX flash (sonda que manda el termostato según AR07). */
static float prevTempReported = TEMP_ERR_VALUE;

static inline void requestImmediateTx(const char *reason) {
  g_immediateTxRequested = true;
  Serial.printf("[TX] flash-tx solicitado por cambio de %s\n", reason);
}

static inline void requestFastPullWindow() {
  g_pullFastUntilMs = millis() + PULL_FAST_WINDOW_MS;
  Serial.println(F("[PULL] ventana rapida 10s (2 min)"));
}

static unsigned long paramsPullIntervalMs(unsigned long nowMs) {
  if (g_pullFastUntilMs != 0 && nowMs < g_pullFastUntilMs) return PARAMS_PULL_MS_FAST;
  return PARAMS_PULL_MS_NORMAL;
}

/** Sonda usada para control (AR07 F53): 0=S1 cámara, 1=S2 evaporador. */
static float controlTempC() {
  if (P.F53 >= 0.5f) {
    return fault2 ? TEMP_ERR_VALUE : tEvap;
  }
  return fault1 ? TEMP_ERR_VALUE : tCam;
}

static void checkTempDeltaForImmediateTx() {
  const float t = controlTempC();
  if (t <= TEMP_ERR_VALUE + 1.0f) return;  // sonda en fallo
  if (prevTempReported <= TEMP_ERR_VALUE + 1.0f) {
    prevTempReported = t;
    return;
  }
  if (fabsf(t - prevTempReported) >= TEMP_DELTA_TX_C) {
    Serial.printf("[TX] delta temp %.2f -> %.2f (umbral %.1f C)\n",
                  prevTempReported, t, TEMP_DELTA_TX_C);
    requestImmediateTx("temperatura");
    prevTempReported = t;
  }
}

// ============== WiFiManager + portal ========
static WiFiManager wm;
static bool g_portalSaveRequested = false;
static unsigned long g_portalStartedAt = 0;
static WiFiManagerParameter p_module("module_id", "Module ID (alta PRO300)", "", 47);
static WiFiManagerParameter p_token("api_key", "Device Token (6+ chars)", "", 47);
static WiFiManagerParameter p_url("api_url", "Ingest URL", "", 199);

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
/**
 * AR06 (F50): si vale 1, los relays son activos HIGH en vez de activos LOW.
 * Por compatibilidad, la salida del 4094 es activa LOW por hardware; lo único
 * que cambia es la condición que activa cada bit (la electrónica suele tener
 * un transistor inversor o no).
 */
static byte relayMask() {
  byte b = 0;
  bool invert = P.F50 >= 0.5f;
  bool cON = invert ? !compresor  : compresor;
  bool dON = invert ? !deshielo   : deshielo;
  bool fON = invert ? !ventilador : ventilador;
  if (cON) b |= (1 << BIT_COMP);
  if (dON) b |= (1 << BIT_DEF);
  if (fON) b |= (1 << BIT_FAN);
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
  // El 7-seg no tiene diagonales: la M la mostramos como N y la V como U para que
  // palabras como "ENVIADOS" se lean (queda "ENUIADOS").
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
/**
 * Layout flush-right: el dígito 3 (más a la derecha) siempre lleva el decimal,
 * el dígito 2 lleva el punto, los dígitos 1 y 0 las decenas y el signo.
 * Ejemplos:  5.3 → "   5.3"   -8.5 → "  -8.5"   22.5 → "  22.5"   -22.5 → " -22.5"
 */
static void mostrarTemperatura(float temp) {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bool neg = temp < 0;
  if (neg) temp = -temp;
  int valor  = (int)round(temp * 10);
  int entero = valor / 10;
  int dec    = valor % 10;

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
static void mostrarError(int idx) {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bufferDisplay[1] = mapaChar('E');
  bufferDisplay[2] = num7seg[idx];
}

// ============== LECTURA NTC =================
/**
 * AR08 (F54) decide cuántas muestras tomamos por lectura (4–32). Aceptamos
 * más muestras = lectura más estable pero más lenta. Saturamos los extremos
 * para no quedarnos sin tiempo de loop si llega un valor raro de la nube.
 */
static float leerNTCpromedio(int pin, bool &fault, float offset) {
  int samples = (int)P.F54;
  if (samples < 4)  samples = 4;
  if (samples > 32) samples = 32;
  long acc = 0;
  int validas = 0;
  for (int i = 0; i < samples; i++) {
    int v = analogRead(pin);
    if (v > 5 && v < 4090) { acc += v; validas++; }
    delayMicroseconds(200);
  }
  if (validas < samples / 2) { fault = true; return TEMP_ERR_VALUE; }
  int adc = acc / validas;
  float rNTC = R_FIXED * ((float)adc / (4095.0f - (float)adc));
  float tK = 1.0f / ((1.0f / T0K) + (1.0f / BETA) * log(rNTC / R0));
  float tC = tK - 273.15f;
  if (tC < -45.0f || tC > 80.0f) { fault = true; return TEMP_ERR_VALUE; }
  fault = false;
  return tC + offset;
}

// ============== CONTROL helpers =============
/** AR07 (F53): qué sonda controla el termostato (0=cámara, 1=evaporador). */
static float controlTemp(bool &controlFault) {
  if (P.F53 >= 0.5f) { controlFault = fault2; return tEvap; }
  controlFault = fault1; return tCam;
}

/** AR05 (F49): comparador frío/calor. */
static bool needCooling(float t, float setp, float hist) {
  if (P.F49 >= 0.5f) {
    // Modo calor: prender cuando temp ≤ setp - hist; apagar al alcanzar setp.
    return t <= setp - hist;
  }
  // Modo frío (default).
  return t >= setp + hist;
}
static bool reachedSetpoint(float t, float setp) {
  if (P.F49 >= 0.5f) return t >= setp;
  return t <= setp;
}

// ============== Puerta (AR35–AR41) ==========
static void leerPuerta() {
  if (DOOR_PIN < 0 || P.F25 < 0.5f) { doorOpen = false; doorAlarm = false; return; }
  int v = digitalRead(DOOR_PIN);
  bool isOpenRaw = (P.F26 >= 0.5f) ? (v == HIGH) : (v == LOW);   // F26: 1=NO, 0=NC
  if (isOpenRaw != doorOpen) {
    doorOpen = isOpenRaw;
    doorChangedAt = millis();
    if (P.F30 >= 0.5f) Serial.printf("[PUERTA] %s\n", doorOpen ? "ABIERTA" : "CERRADA");
  }
  doorAlarm = doorOpen && (millis() - doorChangedAt) >= (unsigned long)(P.F27 * 1000.0f);
}

// ============== CONTROL principal ===========
/**
 * Pisa los relés según los forzados manuales activos. Se llama después de
 * aplicarControl() para que tenga precedencia sobre la decisión del
 * termostato. Cuando el timeout (10 min) expira se desactiva solo y el
 * próximo ciclo de aplicarControl decide normalmente.
 */
static void applyManualOverride() {
  unsigned long now = millis();
  if (OV.compActive && now >= OV.compEndsAt) {
    OV.compActive = false;
    Serial.println(F("[OV] forzado de compresor expiró, vuelvo a auto."));
  }
  if (OV.fanActive && now >= OV.fanEndsAt) {
    OV.fanActive = false;
    Serial.println(F("[OV] forzado de ventilador expiró, vuelvo a auto."));
  }
  // Pisamos SIEMPRE (sin shortcut por igualdad) para que cualquier asignación
  // que haya hecho aplicarControl() recién quede pisada por el override y el
  // próximo refresco del display escriba el SR con el estado correcto.
  if (OV.compActive) {
    if (compresor != OV.compValue) {
      Serial.printf("[OV] piso compresor: %d -> %d (auto perdía vs forzado)\n",
                    compresor ? 1 : 0, OV.compValue ? 1 : 0);
      compChangedAt = now;
    }
    compresor = OV.compValue;
  }
  if (OV.fanActive) {
    if (ventilador != OV.fanValue) {
      Serial.printf("[OV] piso ventilador: %d -> %d\n",
                    ventilador ? 1 : 0, OV.fanValue ? 1 : 0);
    }
    ventilador = OV.fanValue;
  }
}

static void aplicarControl() {
  unsigned long now = millis();

  // Cancelación manual del deshielo (botón DEF de la app durante un ciclo):
  // termina el deshielo, marca lastDefrostAt y pasa al goteo. Si no había
  // deshielo activo, el flag se descarta silenciosamente.
  if (g_manualCancelDefrost) {
    g_manualCancelDefrost = false;
    if (deshielo) {
      deshielo = false;
      lastDefrostAt = now;
      dripping = true;
      dripStartedAt = now;
      if (compresor) { compresor = false; compChangedAt = now; }
      setPhase(PH_DRIP, (uint32_t)(P.F39 * 60.0f));
      Serial.println(F("[CMD] deshielo cancelado por usuario, paso a goteo."));
      return;
    }
  }

  // F38: retardo al encender — todo OFF hasta cumplir el delay.
  if (!bootDelayDone) {
    if (now - bootAtMs < (unsigned long)(P.F38 * 1000.0f)) {
      compresor = ventilador = deshielo = dripping = false;
      setPhase(PH_BOOT, (uint32_t)P.F38);
      return;
    }
    bootDelayDone = true;
    compChangedAt = now;
    lastDefrostAt = now;
    // F09: deshielo al encender.
    if (P.F09 >= 0.5f && !defrostOnStartDone) {
      deshielo = true; defStartedAt = now;
      defrostOnStartDone = true;
      setPhase(PH_DEFROST, (uint32_t)(P.F07 * 60.0f));
      return;
    }
    defrostOnStartDone = true;
  }

  // F46: si pasó "máx sin deshielo", forzar ciclo.
  bool forceDefrost = (P.F46 > 0) && (now - lastDefrostAt) >= (unsigned long)(P.F46 * 60.0f * 1000.0f);

  // F45: bloqueo de deshielo desde encendido (min).
  bool defrostBlockedByStartup = (now - bootAtMs) < (unsigned long)(P.F45 * 60.0f * 1000.0f);

  // ---- SONDAS FALLADAS ----
  bool ctrlFault;
  float tCtrl = controlTemp(ctrlFault);
  if (ctrlFault) {
    deshielo = false; dripping = false;
    if (P.F55 < 0.5f) {
      // AR34 = 0: apagar todo.
      if (compresor) { compresor = false; compChangedAt = now; }
      ventilador = false;
      setPhase(PH_OFF, 0);
      return;
    }
    // AR34 = 1: ciclo de emergencia F19 ON / F20 OFF (s)
    setPhase(PH_EMERG, 0);
    unsigned long onMs  = (unsigned long)(P.F19 * 1000.0f);
    unsigned long offMs = (unsigned long)(P.F20 * 1000.0f);
    if (emergencyComp) {
      if (now - emergencyChangedAt >= onMs) {
        emergencyComp = false; emergencyChangedAt = now;
      }
    } else {
      if (now - emergencyChangedAt >= offMs) {
        emergencyComp = true; emergencyChangedAt = now;
      }
    }
    compresor = emergencyComp;
    ventilador = compresor || P.F51 >= 0.5f;
    return;
  }
  emergencyComp = false;

  // ---- DESHIELO ----
  // Inicio: por tiempo de intervalo (F06) o forzado (F46) o por hielo (F52/F52t)
  bool defrostByIce = (P.F52 >= 0.5f) && !fault2 && (tEvap <= P.F52t);
  bool defrostByInterval = (P.F06 > 0) && (now - lastDefrostAt) >= (unsigned long)(P.F06 * 60.0f * 1000.0f);
  // AR09 (F05): tipo de deshielo
  //   0 = electrico  → relay deshielo ON, compresor OFF
  //   1 = gas caliente → relay deshielo ON + compresor ON (válvula 4 vías / inversion)
  //   2 = natural     → compresor OFF, sin resistencia, solo deja descongelar por inercia
  int defrostType = (int)P.F05;
  // El comando manual `force_defrost` solo puentea el bloqueo de arranque
  // F45 si AR48 (F37) = 1 ("deshielo inmediato al pedir"). Si está en 0, el
  // pedido manual respeta el F45 igual que el deshielo por intervalo.
  bool manualBypassStartup = g_manualDefrostRequested && (P.F37 >= 0.5f);
  bool startDefrost = !deshielo && !dripping &&
      (manualBypassStartup ||
       (!defrostBlockedByStartup &&
        (defrostByInterval || forceDefrost || defrostByIce || g_manualDefrostRequested)));
  if (g_manualDefrostRequested && startDefrost) {
    g_manualDefrostRequested = false;
  } else if (g_manualDefrostRequested && (deshielo || dripping)) {
    // Ya hay un ciclo activo, descartamos el pedido manual.
    g_manualDefrostRequested = false;
    Serial.println(F("[CMD] force_defrost ignorado (ya en deshielo o goteo)."));
  }
  // Si llegamos acá con g_manualDefrostRequested aún true significa que F45
  // está activo y AR48 (F37) = 0: dejamos el flag pendiente y arrancará en
  // el primer ciclo donde defrostBlockedByStartup deje de bloquear.
  if (startDefrost) {
    deshielo = true; defStartedAt = now;
    if (defrostType == 1) {
      // Gas caliente: fuerza compresor ON salteando el tmin (es prioritario).
      if (!compresor) { compresor = true; compChangedAt = now; }
    } else {
      if (compresor) { compresor = false; compChangedAt = now; }
    }
    // AR20 (F10): ventilador durante deshielo (0=apagado, 1=encendido).
    ventilador = (P.F10 >= 0.5f);
    setPhase(PH_DEFROST, (uint32_t)(P.F07 * 60.0f));
    return;
  }

  if (deshielo) {
    bool finPorTemp = !fault2 && (tEvap >= P.F08);
    bool finPorTiempo = (now - defStartedAt) >= (unsigned long)(P.F07 * 60.0f * 1000.0f);
    if (finPorTiempo || finPorTemp) {
      deshielo = false;
      lastDefrostAt = now;
      dripping = true;
      dripStartedAt = now;
      // Si veníamos por gas caliente, apagamos compresor al cerrar el ciclo.
      if (defrostType == 1 && compresor) { compresor = false; compChangedAt = now; }
      setPhase(PH_DRIP, (uint32_t)(P.F39 * 60.0f));
    } else {
      ventilador = (P.F10 >= 0.5f);
      // Sostener compresor ON durante todo el deshielo por gas caliente.
      if (defrostType == 1 && !compresor) { compresor = true; compChangedAt = now; }
      setPhase(PH_DEFROST, (uint32_t)(P.F07 * 60.0f));
    }
    return;
  }

  // ---- GOTEO ----
  if (dripping) {
    // Apaga vent durante el goteo (estándar), salvo F51=1 (vent continuo).
    ventilador = (P.F51 >= 0.5f);
    if ((now - dripStartedAt) >= (unsigned long)(P.F39 * 60.0f * 1000.0f)) {
      dripping = false;
    } else {
      setPhase(PH_DRIP, (uint32_t)(P.F39 * 60.0f));
      return;
    }
  }

  // ---- TERMOSTATO ----
  float setp = P.F01;
  float hist = P.F02;
  unsigned long compMinOnMs  = (unsigned long)(P.F18 * 1000.0f);
  unsigned long compMinOffMs = (unsigned long)(P.F17 * 1000.0f);

  // Puerta abierta puede apagar compresor (F40) y ventilador (F28)
  bool doorCutsComp = (DOOR_PIN >= 0) && P.F25 >= 0.5f && P.F40 >= 0.5f && doorOpen;
  bool doorCutsFan  = (DOOR_PIN >= 0) && P.F25 >= 0.5f && P.F28 >= 0.5f && doorOpen;

  if (compresor) {
    bool wantOff = reachedSetpoint(tCtrl, setp) || doorCutsComp;
    if (wantOff && (now - compChangedAt) >= compMinOnMs) {
      compresor = false; compChangedAt = now;
    }
  } else {
    bool wantOn = needCooling(tCtrl, setp, hist) && !doorCutsComp;
    if (wantOn && (now - compChangedAt) >= compMinOffMs) {
      compresor = true; compChangedAt = now;
    }
  }

  // Ventilador: F51 continuo, F11 retardo post-deshielo, F12 umbral evap
  unsigned long postDefDelayMs = (unsigned long)(P.F11 * 60.0f * 1000.0f);
  bool postDefGate = (now - lastDefrostAt) >= postDefDelayMs;
  bool evapOK = fault2 ? true : (tEvap <= P.F12);
  bool fanLogic = P.F51 >= 0.5f ? true : (compresor && postDefGate && evapOK);
  if (doorCutsFan) fanLogic = false;
  ventilador = fanLogic;

  // Fase post-deshielo: dentro del retardo de ventilador (F11) tras un ciclo.
  // Si no hay retardo o ya pasó, fase normal (refrigeración).
  if (!postDefGate && P.F11 > 0) {
    setPhase(PH_POST_DEFROST, (uint32_t)(P.F11 * 60.0f));
  } else {
    // En "refrigeración" queremos que "Transcurrido" arranque en 0 al
    // entrar a la fase (no que arrastre los minutos del goteo + retardo de
    // ventilador del ciclo previo). `g_phaseStartedAt` queda en millis() al
    // momento de la transición; el "Faltan" se calcula en enviarTelemetria()
    // como F06*60 - (millis() - lastDefrostAt) y se manda en phase_total_s
    // como elapsed + remaining para que la card lo muestre correcto.
    setPhase(PH_NORMAL, (uint32_t)(P.F06 * 60.0f));
  }
}

// ============== ALARMAS =====================
static void evaluarAlarmas() {
  unsigned long now = millis();
  bool startupGate = (now - bootAtMs) >= (unsigned long)(P.F48 * 60.0f * 1000.0f);
  unsigned long delayMs = (unsigned long)(P.F15 * 60.0f * 1000.0f);

  alarmProbe = (P.F16 >= 0.5f) && (fault1 || fault2);

  // Si la puerta está abierta y F29=1, bloquea alarmas térmicas.
  bool maskThermal = (DOOR_PIN >= 0) && P.F25 >= 0.5f && P.F29 >= 0.5f && doorOpen;

  if (fault1 || maskThermal || !startupGate) {
    alarmHigh = alarmLow = false;
    alarmHighSinceMs = alarmLowSinceMs = 0;
    return;
  }

  float hi = P.F13, lo = P.F14, hys = P.F47;
  // Histeresis para evitar parpadeo (F47).
  if (alarmHigh) {
    if (tCam < hi - hys) { alarmHigh = false; alarmHighSinceMs = 0; }
  } else {
    if (tCam >= hi) {
      if (alarmHighSinceMs == 0) alarmHighSinceMs = now;
      if (now - alarmHighSinceMs >= delayMs) alarmHigh = true;
    } else {
      alarmHighSinceMs = 0;
    }
  }
  if (alarmLow) {
    if (tCam > lo + hys) { alarmLow = false; alarmLowSinceMs = 0; }
  } else {
    if (tCam <= lo) {
      if (alarmLowSinceMs == 0) alarmLowSinceMs = now;
      if (now - alarmLowSinceMs >= delayMs) alarmLow = true;
    } else {
      alarmLowSinceMs = 0;
    }
  }
}

// ============== CONFIG: LittleFS ============
static bool ensureFs() {
  static bool done = false;
  if (done) return true;
  if (!LittleFS.begin(true)) {
    Serial.println(F("[FS] LittleFS.begin falló."));
    return false;
  }
  done = true;
  return true;
}
static bool loadConfig() {
  if (!ensureFs()) return false;
  if (!LittleFS.exists(CFG_PATH)) return false;
  File f = LittleFS.open(CFG_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<512> doc;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) {
    Serial.printf("[CFG] JSON corrupto: %s\n", e.c_str());
    return false;
  }
  const char *u = doc["api_url"] | "";
  if (strncmp(u, "https://", 8) == 0 && strstr(u, "/functions/v1/")) {
    strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  }
  strlcpy(g_cfg.moduleId, doc["module_id"] | "", sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey,   doc["api_key"]   | "", sizeof(g_cfg.apiKey));
  g_cfg.intervalMs = doc["interval_ms"] | g_cfg.intervalMs;
  // Hard floor de 60 s para proteger el Free de Supabase. Migra configs viejas
  // que tenían 30 s guardados en LittleFS sin tocar el portal.
  if (g_cfg.intervalMs < 60000) g_cfg.intervalMs = 60000;
  return true;
}
static bool saveConfig() {
  if (!ensureFs()) return false;
  StaticJsonDocument<512> doc;
  doc["api_url"]     = g_cfg.apiUrl;
  doc["module_id"]   = g_cfg.moduleId;
  doc["api_key"]     = g_cfg.apiKey;
  doc["interval_ms"] = g_cfg.intervalMs;
  File f = LittleFS.open(CFG_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  return true;
}
static void resetConfig() {
  if (ensureFs()) {
    if (LittleFS.exists(CFG_PATH))    LittleFS.remove(CFG_PATH);
    if (LittleFS.exists(PARAMS_PATH)) LittleFS.remove(PARAMS_PATH);
  }
  WiFi.disconnect(true, true);
  delay(200);
  ESP.restart();
}

// ============== PARAMS: LittleFS + Cloud =====
/** Lee P.* desde doc. Solo sobreescribe lo que viene; el resto queda con default. */
static void applyParamsFromJson(JsonObject obj) {
  #define ASSIGN(K) do { auto v = obj[#K]; if (!v.isNull()) P.K = v.as<float>(); } while (0)
  ASSIGN(F01); ASSIGN(F02); ASSIGN(F03); ASSIGN(F04); ASSIGN(F05);
  ASSIGN(F06); ASSIGN(F07); ASSIGN(F08); ASSIGN(F09); ASSIGN(F10);
  ASSIGN(F11); ASSIGN(F12); ASSIGN(F13); ASSIGN(F14); ASSIGN(F15);
  ASSIGN(F16); ASSIGN(F17); ASSIGN(F18); ASSIGN(F19); ASSIGN(F20);
  ASSIGN(F25); ASSIGN(F26); ASSIGN(F27); ASSIGN(F28); ASSIGN(F29);
  ASSIGN(F30); ASSIGN(F31); ASSIGN(F32); ASSIGN(F33); ASSIGN(F34);
  ASSIGN(F35); ASSIGN(F36); ASSIGN(F37); ASSIGN(F38); ASSIGN(F39);
  ASSIGN(F40); ASSIGN(F45); ASSIGN(F46); ASSIGN(F47); ASSIGN(F48);
  ASSIGN(F49); ASSIGN(F50); ASSIGN(F51); ASSIGN(F52);
  { auto v = obj["F52t"]; if (!v.isNull()) P.F52t = v.as<float>(); }
  ASSIGN(F53); ASSIGN(F54); ASSIGN(F55);
  #undef ASSIGN
}
static bool loadParams() {
  if (!ensureFs() || !LittleFS.exists(PARAMS_PATH)) return false;
  File f = LittleFS.open(PARAMS_PATH, "r");
  if (!f) return false;
  StaticJsonDocument<4096> doc;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) { Serial.printf("[PARAMS] JSON corrupto: %s\n", e.c_str()); return false; }
  if (doc.containsKey("updated_at")) g_paramsUpdatedAt = String((const char *)(doc["updated_at"] | ""));
  JsonObject obj = doc.containsKey("params") ? doc["params"].as<JsonObject>() : doc.as<JsonObject>();
  applyParamsFromJson(obj);
  return true;
}
static bool saveParams(JsonObject obj) {
  if (!ensureFs()) return false;
  StaticJsonDocument<4096> doc;
  doc["updated_at"] = g_paramsUpdatedAt;
  JsonObject p = doc.createNestedObject("params");
  for (JsonPair kv : obj) p[kv.key()] = kv.value();
  File f = LittleFS.open(PARAMS_PATH, "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  return true;
}

// ============== Comandos manuales (LittleFS) ==============
// Persistimos el `ts` del último comando aplicado para que un reboot no lo
// vuelva a ejecutar.
static const char *CMDTS_PATH = "/cmdts.txt";

static void loadLastCmdTs() {
  if (!ensureFs() || !LittleFS.exists(CMDTS_PATH)) return;
  File f = LittleFS.open(CMDTS_PATH, "r");
  if (!f) return;
  g_lastCmdTs = f.readString();
  g_lastCmdTs.trim();
  f.close();
}

static void saveLastCmdTs() {
  if (!ensureFs()) return;
  File f = LittleFS.open(CMDTS_PATH, "w");
  if (!f) return;
  f.print(g_lastCmdTs);
  f.close();
}

/**
 * Aplica un `pending_command` recibido en la respuesta de fetch-pro300-params.
 * Usa el `ts` como idempotency-key: solo lo procesa si difiere del último que
 * persistimos. Las acciones concretas (forzar comp/fan, gatillar deshielo,
 * cancelar deshielo, cancelar forzados) se materializan vía variables globales
 * que aplicarControl() lee en el próximo ciclo.
 */
static void applyPendingCommand(JsonObject cmd) {
  if (cmd.isNull()) { Serial.println(F("[CMD] cmd object null, skip.")); return; }
  const char *ts = cmd["ts"] | "";
  if (!ts[0]) { Serial.println(F("[CMD] sin ts, skip.")); return; }
  if (g_lastCmdTs == ts) {
    Serial.printf("[CMD] ts %s ya aplicado antes, skip.\n", ts);
    return;
  }

  const char *kind = cmd["kind"] | "";
  bool value = cmd["value"] | false;
  Serial.printf("[CMD] kind=%s value=%d ts=%s\n", kind, value ? 1 : 0, ts);

  unsigned long now = millis();
  bool applied = false;

  if (strcmp(kind, "force_comp") == 0) {
    // AR42 (F31) = 1 habilita el forzado; AR43 (F32) = minutos de duración.
    if (P.F31 < 0.5f) {
      Serial.println(F("[CMD] rechazado: AR42 (F31) = 0, comp manual no habilitado."));
    } else {
      uint32_t mins = (uint32_t)max(1.0f, P.F32);
      OV.compActive = true;
      OV.compValue  = value;
      OV.compEndsAt = now + (unsigned long)mins * 60UL * 1000UL;
      Serial.printf("[OV] comp=FORCE value=%d endsIn=%lus (AR43=%lumin)\n",
                    value ? 1 : 0, (unsigned long)mins * 60UL, (unsigned long)mins);
      applied = true;
    }
  } else if (strcmp(kind, "force_fan") == 0) {
    // AR44 (F33) habilita; AR45 (F34) = duración.
    if (P.F33 < 0.5f) {
      Serial.println(F("[CMD] rechazado: AR44 (F33) = 0, vent manual no habilitado."));
    } else {
      uint32_t mins = (uint32_t)max(1.0f, P.F34);
      OV.fanActive  = true;
      OV.fanValue   = value;
      OV.fanEndsAt  = now + (unsigned long)mins * 60UL * 1000UL;
      Serial.printf("[OV] fan=FORCE value=%d endsIn=%lus (AR45=%lumin)\n",
                    value ? 1 : 0, (unsigned long)mins * 60UL, (unsigned long)mins);
      applied = true;
    }
  } else if (strcmp(kind, "force_defrost") == 0) {
    // AR46 (F35) habilita; AR47 (F36) = anti-spam entre deshielos manuales;
    // AR48 (F37) = bypass F45 (bloqueo de arranque) si vale 1.
    if (P.F35 < 0.5f) {
      Serial.println(F("[CMD] rechazado: AR46 (F35) = 0, deshielo manual no habilitado."));
    } else if (P.F36 > 0 && g_lastManualDefrostAt > 0 &&
               (now - g_lastManualDefrostAt) < (unsigned long)(P.F36 * 60.0f * 1000.0f)) {
      uint32_t restanteS = (uint32_t)(((unsigned long)(P.F36 * 60.0f * 1000.0f) -
                                       (now - g_lastManualDefrostAt)) / 1000UL);
      Serial.printf("[CMD] rechazado: AR47 (F36) anti-spam, faltan %us para el próximo deshielo manual.\n",
                    restanteS);
    } else {
      g_manualDefrostRequested = true;
      g_lastManualDefrostAt    = now;
      Serial.printf("[OV] defrost=MANUAL_REQUEST (AR48 bypass-F45=%s)\n",
                    P.F37 >= 0.5f ? "SI" : "NO");
      applied = true;
    }
  } else if (strcmp(kind, "cancel_defrost") == 0) {
    g_manualCancelDefrost = true;
    Serial.println(F("[OV] defrost=MANUAL_CANCEL"));
    applied = true;
  } else if (strcmp(kind, "cancel_force") == 0) {
    OV.compActive = false;
    OV.fanActive  = false;
    Serial.println(F("[OV] comp+fan=BACK_TO_AUTO"));
    applied = true;
  } else {
    Serial.printf("[CMD] kind desconocido: %s\n", kind);
    return;
  }

  // Persistimos el ts SIEMPRE (haya o no entrado en efecto): así un comando
  // rechazado por gate no se reintenta en loop hasta que la app mande otro.
  g_lastCmdTs = String(ts);
  saveLastCmdTs();
  if (!applied) Serial.println(F("[CMD] comando registrado pero NO aplicado por permisos."));
  else requestFastPullWindow();
}

/** Deriva la URL de fetch-pro300-params desde la URL de ingest-reading guardada. */
static String paramsUrl() {
  String u(g_cfg.apiUrl);
  int idx = u.lastIndexOf("/ingest-reading");
  if (idx > 0) {
    u.remove(idx);
    u += "/fetch-pro300-params";
    return u;
  }
  // Fallback: si el usuario puso otra URL, intentamos derivar igual.
  int slash = u.lastIndexOf('/');
  if (slash > 0) {
    u.remove(slash);
    u += "/fetch-pro300-params";
  }
  return u;
}

/**
 * Hace POST a fetch-pro300-params; si el server devolvió `updated_at` distinto al
 * que tenemos cacheado, aplica los nuevos AR y persiste a /params.json.
 */
static void pullParamsFromCloud() {
  if (WiFi.status() != WL_CONNECTED) { Serial.println(F("[PULL] sin WiFi, salto.")); return; }
  if (strlen(g_cfg.moduleId) == 0 || strlen(g_cfg.apiKey) == 0) {
    Serial.println(F("[PULL] sin moduleId/apiKey, salto."));
    return;
  }
  String url = paramsUrl();
  if (url.length() == 0) { Serial.println(F("[PULL] no pude derivar URL.")); return; }
  Serial.printf("[PULL] -> %s\n", url.c_str());

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(url)) { Serial.println(F("[PULL] http.begin() falló.")); return; }
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<200> req;
  req["moduleId"]    = g_cfg.moduleId;
  req["deviceToken"] = g_cfg.apiKey;
  String body; serializeJson(req, body);

  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  Serial.printf("[PULL] HTTP %d (%d bytes)\n", code, (int)resp.length());
  if (code != 200) {
    Serial.println(resp);
    return;
  }

  StaticJsonDocument<4096> doc;
  DeserializationError e = deserializeJson(doc, resp);
  if (e) {
    Serial.printf("[PULL] JSON error: %s\n", e.c_str());
    Serial.println(resp);
    return;
  }
  // Procesar comandos manuales antes del early return: los comandos llevan
  // `ts` propio y pueden venir aunque los AR no hayan cambiado (la edge
  // function pro300-send-command bumpea updated_at solo como side-effect).
  {
    JsonVariant cmdVar = doc["pending_command"];
    if (cmdVar.is<JsonObject>()) {
      Serial.println(F("[PULL] respuesta trae pending_command, lo proceso."));
      applyPendingCommand(cmdVar.as<JsonObject>());
    } else {
      Serial.println(F("[PULL] respuesta sin pending_command."));
    }
  }

  const char *upd = doc["updated_at"] | "";
  if (upd[0] && g_paramsUpdatedAt == upd) {
    Serial.printf("[PULL] sin cambios (updated_at=%s).\n", upd);
    return;
  }

  // Aceptamos doc["params"] como objeto principal, o doc raíz si la función
  // ya devuelve solo claves F* (fallback defensivo).
  JsonVariant pv = doc["params"];
  JsonObject obj = pv.is<JsonObject>() ? pv.as<JsonObject>() : doc.as<JsonObject>();
  if (obj.isNull()) {
    Serial.println(F("[PULL] respuesta sin 'params', no aplico."));
    Serial.println(resp);
    return;
  }
  if (obj.size() == 0) {
    Serial.printf("[PULL] 'params' vacío en el server. Setpoint/hist/... siguen en defaults.\n");
    g_paramsUpdatedAt = String(upd);
    return;
  }

  g_paramsUpdatedAt = String(upd);
  applyParamsFromJson(obj);
  saveParams(obj);
  Serial.printf("[PULL] AR actualizados desde la nube (%d claves, updated_at=%s).\n",
                (int)obj.size(), upd);
  Serial.printf("       F01=%.1f  F02=%.1f  F06=%.0fmin  F17=%.0fs  F18=%.0fs\n",
                P.F01, P.F02, P.F06, P.F17, P.F18);
  g_flashParamsUpdated = true;
}

// ============== Portal WiFiManager ==========
static void copyPortalConfigAndSave() {
  strlcpy(g_cfg.moduleId, p_module.getValue(), sizeof(g_cfg.moduleId));
  strlcpy(g_cfg.apiKey,   p_token.getValue(),  sizeof(g_cfg.apiKey));
  const char *u = p_url.getValue();
  if (u && strncmp(u, "https://", 8) == 0 && strstr(u, "/functions/v1/")) {
    strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  }
  saveConfig();
  Serial.println(F("[CFG] Guardado desde portal."));
}
/**
 * Abre el portal en modo no-bloqueante. El loop principal sigue corriendo
 * (display, watchdog, lectura de sondas, comandos serie), y procesa el portal
 * con `wm.process()` hasta que dispara la callback de save o se cumple el
 * timeout local que controlamos nosotros.
 */
static void runConfigPortal() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.disconnect(true, true);
  delay(150);
  wm.setBreakAfterConfig(true);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_SEC);
  wm.setConfigPortalBlocking(false);
  wm.startConfigPortal(AP_NAME);
  g_wifiState = WFS_PORTAL;
  g_portalStartedAt = millis();
  modoTexto = true;
  texto = "CONECTAR A RED PRO300-SETUP   ";
  scrollPos = 0;
  prepararTexto();
  Serial.printf("[WiFi] Portal '%s' abierto (modo no bloqueante, %lu s).\n", AP_NAME, PORTAL_TIMEOUT_SEC);
  Serial.println(F("[WiFi] Conéctate con el celular al SSID, abrí 192.168.4.1 y completá WiFi + Module ID + Token."));
}

/** Llamada continua desde loop() mientras g_wifiState == WFS_PORTAL. */
static void processPortal() {
  wm.process();
  if (g_portalSaveRequested) {
    copyPortalConfigAndSave();
    g_portalSaveRequested = false;
    Serial.println(F("[WiFi] Config guardada por el portal. Reiniciando para aplicar..."));
    delay(800);
    ESP.restart();
  }
  if (millis() - g_portalStartedAt > PORTAL_TIMEOUT_SEC * 1000UL) {
    Serial.println(F("[WiFi] Portal: timeout sin cambios. Sigo en control local; reintento WiFi cada 30 s."));
    wm.stopConfigPortal();
    g_wifiState = WFS_RUNNING;
    modoTexto = false;
  }
}
static bool connectSavedWifi() {
  Serial.printf("[WiFi] Probando WiFi guardado (máx. %lu ms)...\n", WIFI_BOOT_CONNECT_MS);
  WiFi.mode(WIFI_STA);
  WiFi.begin();
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < WIFI_BOOT_CONNECT_MS) {
    delay(200);
    yield();
    esp_task_wdt_reset();
  }
  return WiFi.status() == WL_CONNECTED;
}
static void setupWifi() {
  WiFi.setSleep(false);
  WiFi.persistent(true);
  wm.setConnectTimeout(15);
  wm.setMinimumSignalQuality(8);
  wm.setSaveConfigCallback([]() { g_portalSaveRequested = true; });
  p_module.setValue(g_cfg.moduleId, sizeof(g_cfg.moduleId) - 1);
  p_token.setValue(g_cfg.apiKey,    sizeof(g_cfg.apiKey)    - 1);
  p_url.setValue(g_cfg.apiUrl,      sizeof(g_cfg.apiUrl)    - 1);
  wm.addParameter(&p_module);
  wm.addParameter(&p_token);
  wm.addParameter(&p_url);

  bool forcePortal = digitalRead(PIN_FORCE_PORTAL) == LOW;
  bool noConfig    = strlen(g_cfg.moduleId) == 0 || strlen(g_cfg.apiKey) == 0;
  if (forcePortal || noConfig) {
    Serial.println(forcePortal ? F("[WiFi] BOOT a GND → portal forzado.")
                               : F("[WiFi] Sin config → portal automático."));
    runConfigPortal();
    return;
  }
  if (!connectSavedWifi()) {
    Serial.println(F("[WiFi] No conectó en boot. Sigo control local; reintento cada 30 s."));
  } else {
    Serial.printf("[WiFi] OK: SSID=%s IP=%s RSSI=%d\n",
      WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  }
  g_wifiState = WFS_RUNNING;
}
// Reintento de WiFi vive ahora en networkTask() (core 0).

// ============== Telemetría ==================
static void enviarTelemetria() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (strlen(g_cfg.moduleId) == 0 || strlen(g_cfg.apiKey) == 0) return;
  HTTPClient http;
  http.setTimeout(8000);
  http.begin(g_cfg.apiUrl);
  http.addHeader("Content-Type", "application/json");

  String body = "{";
  body += "\"moduleId\":\"";    body += g_cfg.moduleId;  body += "\",";
  body += "\"deviceToken\":\""; body += g_cfg.apiKey;    body += "\",";
  if (!fault1) { body += "\"temp1_c\":" + String(tCam, 2)  + ","; }
  else         { body += "\"temp1_c\":null,"; }
  if (!fault2) { body += "\"temp2_c\":" + String(tEvap, 2); }
  else         { body += "\"temp2_c\":null"; }
  body += ",\"comp_on\":"    + String(compresor  ? "true" : "false");
  body += ",\"fan_on\":"     + String(ventilador ? "true" : "false");
  body += ",\"defrost_on\":" + String(deshielo   ? "true" : "false");
  // Snapshot de fase + cronómetro (para que la card del PRO300 muestre
  // Transcurrido/Faltan/etc. en cualquier bloque, no solo deshielo).
  uint32_t phaseElapsedS = (uint32_t)((millis() - g_phaseStartedAt) / 1000UL);
  uint32_t phaseTotalS = g_phaseTotalS;
  if (g_phase == PH_NORMAL) {
    // El "Faltan" en refrigeración es el tiempo hasta el próximo deshielo
    // por intervalo (F06 minutos desde lastDefrostAt). Lo calculamos al
    // vuelo y reportamos `phase_total_s = elapsed + remaining` para que la
    // app, que hace `remaining = total - elapsed`, dé el countdown real sin
    // arrastrar al "Transcurrido" los minutos del goteo + retardo previo.
    uint32_t intervalS    = (uint32_t)(P.F06 * 60.0f);
    uint32_t sinceLastDef = (uint32_t)((millis() - lastDefrostAt) / 1000UL);
    uint32_t remainingS   = (intervalS > sinceLastDef) ? (intervalS - sinceLastDef) : 0;
    phaseTotalS = phaseElapsedS + remainingS;
  }
  body += ",\"phase\":\"";          body += phaseName(g_phase);  body += "\"";
  body += ",\"phase_elapsed_s\":" + String(phaseElapsedS);
  body += ",\"phase_total_s\":"   + String(phaseTotalS);
  // Segundos restantes de cada forzado manual (0 si está en automático).
  uint32_t compForcedRemS = 0;
  uint32_t fanForcedRemS  = 0;
  if (OV.compActive) {
    unsigned long m = millis();
    compForcedRemS = (m < OV.compEndsAt) ? (uint32_t)((OV.compEndsAt - m) / 1000UL) : 0;
  }
  if (OV.fanActive) {
    unsigned long m = millis();
    fanForcedRemS = (m < OV.fanEndsAt) ? (uint32_t)((OV.fanEndsAt - m) / 1000UL) : 0;
  }
  body += ",\"comp_forced_remaining_s\":" + String(compForcedRemS);
  body += ",\"fan_forced_remaining_s\":"  + String(fanForcedRemS);
  if (DOOR_PIN >= 0 && P.F25 >= 0.5f) {
    body += ",\"door_open\":" + String(doorOpen ? "true" : "false");
  }
  body += "}";

  int code = http.POST(body);
  String resp = http.getString();
  Serial.print(F("[TX] POST ")); Serial.print(code);
  if (code > 0) { Serial.print(' '); Serial.println(resp); }
  else          { Serial.println(); }
  http.end();
  if (code != 200) return;

  g_flashTelemetrySent = true;

  // Atajo de propagación: si el server nos cuenta que `params_updated_at` del
  // combistato es más nuevo que el que tenemos, pedimos un pull inmediato.
  // Así editás un AR en la app y a los pocos segundos lo aplica el equipo.
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, resp) == DeserializationError::Ok) {
    const char *pu = doc["params_updated_at"] | "";
    if (pu[0] && g_paramsUpdatedAt != pu) {
      Serial.printf("[TX] Detecté params nuevos (%s vs %s) → forzando pull.\n",
                    g_paramsUpdatedAt.c_str(), pu);
      g_pullNowRequested = true;
      requestFastPullWindow();
    }
  }
}

// ============== Comandos serie ==============
static void printConfig() {
  Serial.println(F("---- CONFIG ----"));
  Serial.printf("WiFi SSID: %s  (status=%d)\n", WiFi.SSID().c_str(), WiFi.status());
  Serial.printf("api_url:   %s\n", g_cfg.apiUrl);
  Serial.printf("module_id: %s\n", g_cfg.moduleId);
  Serial.printf("api_key:   %s\n", g_cfg.apiKey);
  Serial.printf("interval:  %lu ms\n", (unsigned long)g_cfg.intervalMs);
  Serial.printf("params updated_at: %s\n", g_paramsUpdatedAt.c_str());
  Serial.println(F("---- AR vigentes ----"));
  Serial.printf("AR01 F01 setpoint     = %.1f\n", P.F01);
  Serial.printf("AR02 F02 hist         = %.1f\n", P.F02);
  Serial.printf("AR03 F03 offS1        = %.1f\n", P.F03);
  Serial.printf("AR04 F04 offS2        = %.1f\n", P.F04);
  Serial.printf("AR05 F49 modo (0fri)  = %.0f\n", P.F49);
  Serial.printf("AR06 F50 inv. relé    = %.0f\n", P.F50);
  Serial.printf("AR07 F53 sonda ctrl   = %.0f\n", P.F53);
  Serial.printf("AR08 F54 muestras     = %.0f\n", P.F54);
  Serial.printf("AR10 F06 int defrost  = %.0f min\n", P.F06);
  Serial.printf("AR11 F07 max defrost  = %.0f min\n", P.F07);
  Serial.printf("AR12 F08 fin defrost  = %.1f\n", P.F08);
  Serial.printf("AR14 F38 boot delay   = %.0f s\n", P.F38);
  Serial.printf("AR15 F39 goteo        = %.0f min\n", P.F39);
  Serial.printf("AR20 F10 fan en def   = %.0f\n", P.F10);
  Serial.printf("AR21 F11 ret fan post = %.0f min\n", P.F11);
  Serial.printf("AR23 F51 fan continuo = %.0f\n", P.F51);
  Serial.printf("AR24 F13 alarma alta  = %.1f\n", P.F13);
  Serial.printf("AR25 F14 alarma baja  = %.1f\n", P.F14);
  Serial.printf("AR30 F17 tmin OFF     = %.0f s\n", P.F17);
  Serial.printf("AR31 F18 tmin ON      = %.0f s\n", P.F18);
  Serial.printf("AR34 F55 emerg falla  = %.0f\n", P.F55);
  Serial.println(F("--------------------"));
}
static void leerSerial() {
  if (!Serial.available()) return;
  String dato = Serial.readStringUntil('\n');
  dato.trim();
  if (dato.length() == 0) return;
  String lower = dato; lower.toLowerCase();

  if (lower == "portal")  { runConfigPortal(); return; }
  if (lower == "reset")   { Serial.println(F("Reseteando config...")); resetConfig(); return; }
  if (lower == "config")  { printConfig(); return; }
  if (lower == "reboot")  { ESP.restart(); return; }
  if (lower == "temp")    { modoTexto = false; return; }
  if (lower == "pull")    { Serial.println(F("[PULL] solicitando pull a la task de red...")); g_pullNowRequested = true; return; }
  if (lower == "off") {
    compresor = ventilador = deshielo = false;
    modoTexto = true; texto = "OFF"; scrollPos = 0; prepararTexto();
    return;
  }
  if (lower == "defrost" || lower == "deshielo") {
    lastDefrostAt = 0;
    Serial.println(F("Forzando deshielo en próximo tick."));
    return;
  }
  modoTexto = true;
  texto = dato; scrollPos = 0; prepararTexto();
}

// ============== Display task (core 1, prio 2) ==============
/**
 * Multiplexa los 5 comunes (4 dígitos + fila de luces) escribiendo cada uno
 * cada `kPeriodMs` ticks. Como vTaskDelay devuelve el control a FreeRTOS,
 * cualquier otra task de igual o menor prioridad (loop=1) corre entre cada
 * refresco. Con prio 2 quedamos por encima del loop y nos garantizamos que
 * los logs / NTC / SPI ocasionales no le coman ciclos al display.
 */
static void displayTask(void *param) {
  // El bus SPI lo inicializó setup(). beginTransaction asegura que estamos
  // configurados con MSBFIRST/MODE0/1MHz desde esta task (no liberamos: nadie
  // más usa el bus).
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  const TickType_t kPeriod = pdMS_TO_TICKS(1);
  for (;;) {
    refrescarDisplay();
    vTaskDelay(kPeriod);
  }
}

// ============== Network task (core 0) =======
/**
 * Corre en core 0 y se ocupa de:
 *   - reintento de WiFi cuando se cae,
 *   - POST de telemetría cada g_cfg.intervalMs,
 *   - pull AR/comandos: 60 s en reposo, 10 s tras comando o params nuevos (2 min).
 * El loop principal (core 1) queda libre para multiplexar el 7-seg y atender los
 * cálculos de control sin que un POST HTTP de varios segundos congele el display.
 */
static void networkTask(void *param) {
  esp_task_wdt_add(NULL);
  unsigned long lastTel = 0;
  unsigned long lastPull = 0;
  unsigned long lastRetry = 0;
  for (;;) {
    esp_task_wdt_reset();

    if (g_wifiState == WFS_RUNNING) {
      // Reintentar WiFi si se cayó.
      if (WiFi.status() != WL_CONNECTED) {
        if (lastRetry == 0 || (millis() - lastRetry) >= 30000UL) {
          lastRetry = millis();
          if (WiFi.SSID().length() > 0) {
            Serial.println(F("[WiFi] Reintentando (task)..."));
            WiFi.reconnect();
          }
        }
      } else {
        // TX baseline cada g_cfg.intervalMs (60 s) + TX inmediato cuando el
        // loop detecta un cambio de relé / fase / puerta. El rate-limit de
        // IMMEDIATE_TX_MIN_GAP_MS evita que un relé que chattea reviente la
        // cuota Free. Si el evento llega y el gap todavía no pasó, el flag
        // queda pendiente y se sirve en el próximo tick (200 ms).
        const unsigned long nowMs = millis();
        bool sendNow = false;
        if (nowMs - lastTel >= g_cfg.intervalMs) {
          sendNow = true;
        }
        if (g_immediateTxRequested) {
          const bool gapOk = (g_lastImmediateTxAt == 0) ||
                             (nowMs - g_lastImmediateTxAt >= IMMEDIATE_TX_MIN_GAP_MS);
          if (gapOk) {
            sendNow = true;
            g_immediateTxRequested = false;
            g_lastImmediateTxAt = nowMs;
            Serial.println(F("[TX] disparando flash-tx (evento)"));
          }
          // else: flag queda pendiente y el próximo loop la atiende.
        }
        if (sendNow) {
          lastTel = nowMs;
          enviarTelemetria();
        }
        {
          const unsigned long pullEvery = paramsPullIntervalMs(nowMs);
          if (g_pullNowRequested || (nowMs - lastPull >= pullEvery)) {
            lastPull = nowMs;
            g_pullNowRequested = false;
            pullParamsFromCloud();
          }
        }
      }
    }

    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

// ============== Setup / Loop ================
void setup() {
  Serial.begin(115200);
  pinMode(STROBE_PIN, OUTPUT);
  digitalWrite(STROBE_PIN, LOW);
  pinMode(PIN_FORCE_PORTAL, INPUT_PULLUP);
  if (DOOR_PIN >= 0) pinMode(DOOR_PIN, INPUT_PULLUP);
  analogReadResolution(12);

  SPI.begin(CLOCK_PIN, -1, DATA_PIN, -1);
  // Inicializa los 4094 con todo apagado. Cerramos la transacción para
  // liberar el mutex interno del SPI; si no, displayTask se queda esperando
  // para siempre cuando intenta su propio beginTransaction() → display negro.
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  enviar4094(comunesApagados(), 0xFF);
  SPI.endTransaction();

  Serial.println();
  Serial.println(F("S.G PRO300 booteando..."));
  Serial.println(F("[FW] Fase1: TX 60s + eventos + deltaT + pull 60s/10s"));
  ensureFs();
  loadConfig();
  loadParams();
  loadLastCmdTs();
  printConfig();

  // Watchdog: 30 s (suficiente para conexiones WiFi lentas + portal).
#if defined(ESP_IDF_VERSION_MAJOR) && ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t twdt_cfg = {
    .timeout_ms     = 30000,
    .idle_core_mask = 0,
    .trigger_panic  = true,
  };
  if (esp_task_wdt_init(&twdt_cfg) == ESP_ERR_INVALID_STATE) {
    esp_task_wdt_reconfigure(&twdt_cfg);
  }
#else
  esp_task_wdt_init(30, true);
#endif
  esp_task_wdt_add(NULL);

  bootAtMs = millis();
  bootDelayDone = false;
  defrostOnStartDone = false;
  emergencyChangedAt = bootAtMs;
  compChangedAt = bootAtMs;
  lastDefrostAt = bootAtMs;

  texto = "BOOT"; prepararTexto();

  setupWifi();
  if (g_wifiState != WFS_PORTAL) modoTexto = false;

  // Si ya está conectado al arrancar, marcamos pull inmediato para que la task
  // de red lo levante en cuanto comience (no bloqueamos el setup con HTTP).
  if (WiFi.status() == WL_CONNECTED) {
    g_pullNowRequested = true;
  }

  // Network task en core 0 para que los POST/HTTPS no congelen el display.
  xTaskCreatePinnedToCore(
    networkTask,        // función
    "net",              // nombre
    8192,               // stack
    NULL,               // parámetro
    1,                  // prioridad (loop = 1 por default)
    &g_netTaskHandle,   // handle
    0                   // core 0
  );

  // Display task en core 1 con prioridad mayor que loopTask. Refresca el
  // multiplex cada 1 ms sin que el resto del firmware le robe ciclos.
  xTaskCreatePinnedToCore(
    displayTask,
    "disp",
    2048,
    NULL,
    2,
    &g_displayTaskHandle,
    1                   // core 1, junto al loop pero con prio más alta
  );
}

void loop() {
  esp_task_wdt_reset();
  leerSerial();

  if (g_wifiState == WFS_PORTAL) processPortal();

  // Refresco del display vive ahora en displayTask (core 1, prio 2).
  // El loop solo se ocupa de control, NTC, marquesinas y portal.

  if (millis() - lastReadAt >= 1000) {
    lastReadAt = millis();
    tCam  = leerNTCpromedio(NTC1_PIN, fault1, P.F03);
    tEvap = leerNTCpromedio(NTC2_PIN, fault2, P.F04);
    leerPuerta();
    aplicarControl();
    applyManualOverride();
    evaluarAlarmas();

    // Detectar transiciones y pedir TX inmediato. Se mira *después* del
    // override manual así un click en la app (force_comp, etc.) se ve en
    // tiempo real sin tener que esperar al próximo ciclo de 60 s.
    if (compresor != prevCompresor) {
      requestImmediateTx(compresor ? "comp ON" : "comp OFF");
      prevCompresor = compresor;
    }
    if (ventilador != prevVentilador) {
      requestImmediateTx(ventilador ? "vent ON" : "vent OFF");
      prevVentilador = ventilador;
    }
    if (deshielo != prevDeshielo) {
      requestImmediateTx(deshielo ? "deshielo ON" : "deshielo OFF");
      prevDeshielo = deshielo;
    }
    if (dripping != prevDripping) {
      requestImmediateTx(dripping ? "goteo ON" : "goteo OFF");
      prevDripping = dripping;
    }
    if (doorOpen != prevDoorOpen) {
      requestImmediateTx(doorOpen ? "puerta ABIERTA" : "puerta CERRADA");
      prevDoorOpen = doorOpen;
    }
    if (g_phase != prevPhase) {
      requestImmediateTx(phaseName(g_phase));
      prevPhase = g_phase;
    }
    checkTempDeltaForImmediateTx();
  }

  // ---- Mensajes efímeros en marquesina (TX OK / AR actualizados) ----
  // Se disparan desde networkTask en core 0; el loop arma el scroll y vuelve a
  // temperatura cuando vence el timeout. No se activan durante el portal.
  if (g_wifiState != WFS_PORTAL) {
    if (g_flashTelemetrySent) {
      g_flashTelemetrySent = false;
      g_flashActive = true;
      modoTexto = true;
      texto = "DATOS ENVIADOS   ";
      scrollPos = 0;
      prepararTexto();
      g_flashEndsAt = millis() + 3500UL;
    } else if (g_flashParamsUpdated) {
      g_flashParamsUpdated = false;
      g_flashActive = true;
      modoTexto = true;
      texto = "DATOS CARGADOS   ";
      scrollPos = 0;
      prepararTexto();
      g_flashEndsAt = millis() + 3500UL;
    }
  }
  if (g_flashActive && millis() >= g_flashEndsAt) {
    g_flashActive = false;
    modoTexto = false;
  }

  if (modoTexto && millis() - lastScroll >= 300) {
    lastScroll = millis();
    prepararTexto();
  }
  if (!modoTexto && millis() - lastDisplaySwitchAt >= 1000) {
    lastDisplaySwitchAt = millis();
    if (fault1) mostrarError(1);
    else        mostrarTemperatura(tCam);
  }

  // OJO: la telemetría, pull de AR y reintento de WiFi viven ahora en
  // networkTask() pinneada al core 0. El loop solo se ocupa del display,
  // sondas, control y portal.
}
