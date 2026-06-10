/**
 * AR Monitoreo — Plaqueta "PRO300 con control" (ESP32 + 2x CD4094)
 * ----------------------------------------------------------------------
 * Fase B: el ESP32 baja los 48 parámetros AR01–AR48 desde Supabase
 *         (Edge Function `fetch-pro300-params`, tabla `combistatos.params`).
 *
 * Hardware:
 *   - ESP32 (DOIT DevKit / NodeMCU-32S).
 *   - 2 NTC 10k beta 3950: NTC1 GPIO34 (cámara/ambiente), NTC2 GPIO35 (evaporador).
 *     Divisor: 3V3 — 10k (R_fixed) — ADC — NTC — GND.
 *     Si la temp sale invertida, cambiá NTC_R_SERIES_TO_VCC a 0 al inicio del .ino.
 *   - 2x CD4094 en cascada por SPI:
 *       4094 #1 = byte SEGMENTOS (a..g + dp), 7-seg activo en LOW.
 *       4094 #2 = bit 0..4 COM1..COM5 (4 dígitos + fila de 7 luces)
 *                 bit 5 RELAY COMPRESOR  (activo LOW)
 *                 bit 6 RELAY DESHIELO   (activo LOW)
 *                 bit 7 RELAY VENTILADOR (activo LOW)
 *     Fila indicadores (COM5, segmento activo LOW):
 *       1 compresor | 2 forzador (ventilador ON o forzado manual) | 3 deshielo
 *       | 4 envío (parpadea) | 5 WiFi conectado | 6–7 reservadas
 *   - SPI:  DATA=23 (MOSI), CLOCK=18 (SCK), STROBE=5 (latch).
 *   - DOOR_PIN: opcional. Si tu plaqueta tiene microswitch de puerta cableado
 *               a un GPIO, cambiá `DOOR_PIN` y se activa toda la lógica AR35–AR41.
 *               Con -1 (default) los parámetros se guardan pero no se accionan.
 *   - Botones (un terminal a GPIO, otro a GND; INPUT_PULLUP):
 *       UP=13  DOWN=14  SET=27  BACK=17
 *     Relés por CD4094 (bits 5/6/7), no por GPIO. Combistato genérico usa SET=16.
 *     Atajos:
 *       UP+DOWN 1,2 s → menú AR | SET+ABAJO 1 s → portal WiFi (también SET+UP/VOLVER o SET 4 s)
 *       UP solo 1,2 s   → deshielo manual | UP toque en deshielo/goteo → parar deshielo
 *       DOWN toque       → alterna: temp S1 / fase (español) / minutos restantes
 *       VOLVER toque      → ver temperatura sonda 2 (evaporador); otra vez vuelve a S1
 *
 * Modo local: el control (sondas, relés, AR, display) arranca SIEMPRE, tenga o no
 * WiFi / module_id / api_key. La nube es opcional (telemetría y pull de AR).
 *
 * Provisión WiFi/nube (solo si el usuario lo pide):
 *   1) SET+ABAJO 1 s, SET 4 s, o comando serie `portal` → AP "PRO300-Setup".
 *   2) GPIO0 (botón BOOT) a GND al energizar → fuerza portal en ese arranque.
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
#include "driver/gpio.h"

// Prototipos / constantes usados antes de su definición (Arduino 1.8 no ordena bien el .ino).
static void runConfigPortal();
static void flashUiMessage(const char *msg, unsigned long ms);
static void requestManualDefrostFromButton();
static void printLittleFsReport();

// ============== PINES =======================
#define DATA_PIN          23
#define CLOCK_PIN         18
#define STROBE_PIN        5
#define NTC1_PIN          34   // sonda cámara / ambiente
#define NTC2_PIN          35   // sonda evaporador
#define PIN_FORCE_PORTAL  0    // BOOT button: a GND al arranque → fuerza portal
#define DOOR_PIN         -1    // -1 = sin sensor de puerta; cambialo a un GPIO si lo cableaste
#define BTN_UP_PIN       13    // botón subir
#define BTN_DOWN_PIN     14    // botón bajar
#define BTN_SET_PIN      27    // set / confirmar (PRO300; relés van por CD4094, no por este pin)
#define BTN_BACK_PIN     17    // volver / cancelar
/** 1 = botón a GND al apretar (pull-up). 0 = botón a 3.3V al apretar (pull-down). */
#define BTN_ACTIVE_LOW   1

// ============== NTC =========================
/** 1 = 3V3-10k-ADC-NTC-GND (estándar). 0 = 3V3-NTC-ADC-10k-GND. */
#ifndef NTC_R_SERIES_TO_VCC
#define NTC_R_SERIES_TO_VCC 1
#endif
static constexpr float R_FIXED = 10000.0f;
static constexpr float BETA    = 3950.0f;
static constexpr float T0K     = 298.15f;
static constexpr float R0      = 10000.0f;
static constexpr float TEMP_ERR_VALUE = -127.0f;
/** Ambiente muy caliente (ej. 40 °C en cámara): aviso y menos carga WiFi en el ESP. */
static constexpr float CAMBIENT_HOT_C     = 38.0f;
static constexpr float CHIP_TEMP_WARN_C = 68.0f;
/** Relés siempre OFF al menos este tiempo tras energizar (aunque AR14=0). */
static constexpr unsigned long RELAY_BOOT_MIN_MS = 10000UL;
/** Tras encender, no entrar en ciclo de emergencia por sonda hasta estabilizar ADC. */
static constexpr unsigned long SENSOR_FAULT_GRACE_MS = 45000UL;
static constexpr uint8_t NTC_FAULT_SET_COUNT = 3;
static constexpr uint8_t NTC_FAULT_CLR_COUNT = 2;

// ============== LAYOUT 4094 #2 ==============
#define BIT_COM1 0
#define BIT_COM2 1
#define BIT_COM3 2
#define BIT_COM4 3
#define BIT_COM5 4
/** Fila de 7 luces (COM5, bits 0..6 del segmento; activo LOW). */
#define BIT_LED_COMP   0  // 1.ª izq — símbolo compresor
#define BIT_LED_FORZ   1  // 2.ª — ventilador/forzador ON o forzado manual activo
#define BIT_LED_DEF    2  // 3.ª — deshielo
#define BIT_LED_TX     3  // 4.ª — parpadea al enviar telemetría
#define BIT_LED_CLOUD  4  // 5.ª — encendida = WiFi conectado
#define BIT_COMP 5
#define BIT_DEF  6
#define BIT_FAN  7

// ============== CONFIG ======================
static constexpr const char *CFG_PATH       = "/config.json";
static constexpr const char *PARAMS_PATH    = "/params.json";
static constexpr const char *CMDTS_PATH     = "/cmdts.txt";
static constexpr const char *AP_NAME        = "PRO300-Setup";
static constexpr unsigned long PORTAL_TIMEOUT_SEC   = 5UL * 60UL;
static constexpr unsigned long WIFI_BOOT_CONNECT_MS = 20000UL;
// 60 s reduce a la mitad la carga de inserts en `device_readings`/`combistato_readings`
// y mantiene el Free tier de Supabase con aire. La temperatura de cámara cambia en
// minutos, no en segundos, así que 1 punto/min sigue siendo de sobra para gráficos.
static constexpr unsigned long TELEMETRY_DEFAULT_MS = 60000UL;
/** Pull AR + pending_command: 20 s en reposo (solo lectura, no inserts); 5 s si hay comando pendiente. */
static constexpr unsigned long PARAMS_PULL_MS_NORMAL = 20UL * 1000UL;
static constexpr unsigned long PARAMS_PULL_MS_FAST   = 10UL * 1000UL;
static constexpr unsigned long PARAMS_PULL_MS_URGENT = 5UL * 1000UL;
static constexpr unsigned long PULL_FAST_WINDOW_MS     = 2UL * 60UL * 1000UL;
static constexpr unsigned long PULL_URGENT_WINDOW_MS   = 90UL * 1000UL;
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
  float F54 = 16.0f;    // AR08 muestras promedio ADC (4–32)

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

/** Menú local AR01–AR48 en display (definido antes de funciones que lo usan; Arduino genera prototipos arriba). */
struct ParamMenuItem {
  const char *code;
  float *value;
  float step;
  float minValue;
  float maxValue;
};

static ParamMenuItem g_paramMenu[] = {
  // AR01 setpoint: rango amplio (frío -50 °C … calor +50 °C); antes max 20 bloqueaba el ajuste.
  {"01", &P.F01, 0.5f, -50.0f, 50.0f},  {"02", &P.F02, 0.1f, 0.5f, 20.0f},
  {"03", &P.F03, 0.1f, -10.0f, 10.0f},  {"04", &P.F04, 0.1f, -10.0f, 10.0f},
  {"05", &P.F49, 1.0f, 0.0f, 1.0f},     {"06", &P.F50, 1.0f, 0.0f, 1.0f},
  {"07", &P.F53, 1.0f, 0.0f, 1.0f},     {"08", &P.F54, 1.0f, 4.0f, 32.0f},
  {"09", &P.F05, 1.0f, 0.0f, 1.0f},     {"10", &P.F06, 1.0f, 1.0f, 9999.0f},
  {"11", &P.F07, 1.0f, 1.0f, 999.0f},   {"12", &P.F08, 0.5f, -40.0f, 40.0f},
  {"13", &P.F09, 1.0f, 0.0f, 1.0f},     {"14", &P.F38, 1.0f, 0.0f, 600.0f},
  {"15", &P.F39, 1.0f, 0.0f, 120.0f},   {"16", &P.F45, 1.0f, 0.0f, 9999.0f},
  {"17", &P.F46, 1.0f, 0.0f, 9999.0f},  {"18", &P.F52, 1.0f, 0.0f, 1.0f},
  {"19", &P.F52t, 0.5f, -40.0f, 40.0f}, {"20", &P.F10, 1.0f, 0.0f, 1.0f},
  {"21", &P.F11, 1.0f, 0.0f, 999.0f},   {"22", &P.F12, 0.5f, -40.0f, 40.0f},
  {"23", &P.F51, 1.0f, 0.0f, 1.0f},     {"24", &P.F13, 0.5f, -40.0f, 80.0f},
  {"25", &P.F14, 0.5f, -40.0f, 80.0f},  {"26", &P.F15, 1.0f, 0.0f, 120.0f},
  {"27", &P.F16, 1.0f, 0.0f, 1.0f},     {"28", &P.F47, 0.1f, 0.0f, 20.0f},
  {"29", &P.F48, 1.0f, 0.0f, 999.0f},   {"30", &P.F17, 1.0f, 0.0f, 3600.0f},
  {"31", &P.F18, 1.0f, 0.0f, 3600.0f},  {"32", &P.F19, 1.0f, 0.0f, 3600.0f},
  {"33", &P.F20, 1.0f, 0.0f, 3600.0f},  {"34", &P.F55, 1.0f, 0.0f, 1.0f},
  {"35", &P.F25, 1.0f, 0.0f, 1.0f},     {"36", &P.F26, 1.0f, 0.0f, 1.0f},
  {"37", &P.F27, 1.0f, 0.0f, 9999.0f},  {"38", &P.F28, 1.0f, 0.0f, 1.0f},
  {"39", &P.F29, 1.0f, 0.0f, 1.0f},     {"40", &P.F30, 1.0f, 0.0f, 1.0f},
  {"41", &P.F40, 1.0f, 0.0f, 1.0f},     {"42", &P.F31, 1.0f, 0.0f, 1.0f},
  {"43", &P.F32, 1.0f, 1.0f, 999.0f},   {"44", &P.F33, 1.0f, 0.0f, 1.0f},
  {"45", &P.F34, 1.0f, 1.0f, 999.0f},   {"46", &P.F35, 1.0f, 0.0f, 1.0f},
  {"47", &P.F36, 1.0f, 0.0f, 999.0f},   {"48", &P.F37, 1.0f, 0.0f, 1.0f},
};
#define PARAM_MENU_COUNT ((int)(sizeof(g_paramMenu) / sizeof(g_paramMenu[0])))

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
/** AR10/F06/F46: intervalo hasta el próximo deshielo (desde fin de goteo). */
static unsigned long lastDefrostAt = 0;
/** AR21/F11: retardo ventilador post-deshielo (desde fin de resistencia / inicio goteo). */
static unsigned long lastDefrostHeatOffAt = 0;
static unsigned long lastReadAt = 0;
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
/** Promedio móvil de lecturas (1/s) para estabilizar el decimal en pantalla. */
static constexpr int TEMP_ROLL_AVG_N = 8;
static float tCamRoll[TEMP_ROLL_AVG_N];
static float tEvapRoll[TEMP_ROLL_AVG_N];
static uint8_t tRollIdx = 0;
static uint8_t tRollFill = 0;

static void resetTempRollBuffers() {
  for (int i = 0; i < TEMP_ROLL_AVG_N; i++) {
    tCamRoll[i] = TEMP_ERR_VALUE;
    tEvapRoll[i] = TEMP_ERR_VALUE;
  }
  tRollIdx = 0;
  tRollFill = 0;
}

static bool tempRollSampleValid(float t) {
  return t > -80.0f && t < 75.0f;
}

static volatile bool g_txInProgress = false;
static constexpr unsigned long TX_LED_BLINK_MS = 280UL;
static bool  fault1 = false, fault2 = false;
static uint8_t ntcBadStreak1 = 0, ntcBadStreak2 = 0;
static uint8_t ntcGoodStreak1 = 0, ntcGoodStreak2 = 0;
static bool  ntcReady = false;
static bool  g_ntcBootDiagPending = true;
static unsigned long relaySafeUntilMs = 0;

static bool   modoTexto = true;
static String texto = "BOOT";
static int    scrollPos = 0;

static byte bufferDisplay[4] = {0xFF, 0xFF, 0xFF, 0xFF};
static int  digitNow = 0;
static unsigned long lastScroll=0;
static unsigned long g_portalScrollAt = 0;

// Task dedicada a HTTP (telemetría + pull). Corre en core 0 para no bloquear
// la multiplexación del display (que está en el loopTask = core 1).
static TaskHandle_t g_netTaskHandle = NULL;
// Task dedicada exclusivamente al refresco multiplexado del 7-seg. Corre en
// core 1 con prioridad mayor que el loopTask, así ningún cálculo / log /
// portal / NTC le roba ciclos al display (causa principal de parpadeo).
static TaskHandle_t g_displayTaskHandle = NULL;
static bool          g_pullNowRequested = false;   // pedido desde serie / params_updated_at
static unsigned long g_pullFastUntilMs  = 0;     // ventana de pull rápido (botones / AR)
static unsigned long g_pullUrgentUntilMs = 0;    // comando pendiente en nube (pull cada 5 s)
// Mensajes efímeros en marquesina (7-seg: sin tildes; evitar M/V → N/U en adaptarTexto).
enum : uint8_t {
  FP_NONE = 0,
  FP_WIFI = 1,
  FP_CALOR = 2,
  FP_ENVIADO = 3,
  FP_PARAM = 4,
  FP_ENVIANDO = 5,
};
static volatile uint8_t g_flashPending = FP_NONE;
static bool          g_flashActive   = false;
static unsigned long g_flashEndsAt   = 0;
static bool          g_prevWifiConnected = false;
static unsigned long g_hotDerateUntilMs  = 0;
static unsigned long g_lastCalorFlashMs  = 0;

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

// ============== UI botones local (parámetros) ======
static constexpr unsigned long BTN_DEBOUNCE_MS = 35UL;
static constexpr unsigned long BTN_ENTER_PARAMS_HOLD_MS = 1200UL;
static constexpr unsigned long BTN_WIFI_PORTAL_HOLD_MS  = 800UL;
static constexpr unsigned long BTN_WIFI_SET_SOLO_HOLD_MS = 4000UL;
static constexpr unsigned long BTN_PORTAL_RELEASE_DEBOUNCE_MS = 80UL;
static constexpr unsigned long PORTAL_WDT_TIMEOUT_MS = 180000UL;
static constexpr unsigned long BTN_DEFROST_HOLD_MS      = 1200UL;
static constexpr unsigned long BTN_EDIT_REPEAT_MS       = 280UL;
enum UiMode { UI_NORMAL, UI_PARAM_SELECT, UI_PARAM_EDIT };
/** En pantalla normal: 0=temp S1, 1=fase (español), 2=min restantes. VOLVER = sonda 2 aparte. */
enum NormalDispMode { DISP_TEMP = 0, DISP_PHASE = 1, DISP_REMAIN = 2 };
static NormalDispMode g_normalDisp = DISP_TEMP;
static bool g_showSonda2View = false;
static UiMode g_uiMode = UI_NORMAL;
static bool g_btnPrev[4] = {false, false, false, false};
static unsigned long g_btnLastEdgeMs[4] = {0, 0, 0, 0};
static unsigned long g_btnBothPressedAt = 0;
static int g_paramCursor = 0;
static float g_paramEditOriginal = 0.0f;
/** Tras entrar con UP+DOWN: ignorar toques hasta soltar todos (evita que SET no registre). */
static bool g_menuWaitRelease = false;
static unsigned long g_setHeldAt = 0;
static unsigned long g_portalComboHeldAt = 0;
static unsigned long g_portalComboReleasedAt = 0;
static bool g_portalHoldHintShown = false;
static bool g_portalRunning = false;
static bool g_setHoldMenuDone = false;
static unsigned long g_upDefrostHeldAt = 0;
static bool g_upDefrostHoldFired = false;
/** UP mantenido: ignora bloqueo F45 una vez (como AR48 inmediato). */
static bool g_btnDefrostImmediate = false;
static unsigned long g_editRepeatAt = 0;

static inline void requestImmediateTx(const char *reason) {
  g_immediateTxRequested = true;
  Serial.printf("[TX] flash-tx solicitado por cambio de %s\n", reason);
}

static inline void requestFastPullWindow() {
  g_pullFastUntilMs = millis() + PULL_FAST_WINDOW_MS;
  Serial.println(F("[PULL] ventana rapida 10s (2 min)"));
}

static unsigned long paramsPullIntervalMs(unsigned long nowMs) {
  if (g_pullUrgentUntilMs != 0 && nowMs < g_pullUrgentUntilMs) return PARAMS_PULL_MS_URGENT;
  if (g_pullFastUntilMs != 0 && nowMs < g_pullFastUntilMs) return PARAMS_PULL_MS_FAST;
  return PARAMS_PULL_MS_NORMAL;
}

static void requestUrgentPullWindow() {
  g_pullUrgentUntilMs = millis() + PULL_URGENT_WINDOW_MS;
  g_pullNowRequested = true;
  Serial.println(F("[PULL] ventana urgente 5s (comando pendiente en nube, 90s)"));
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
static WiFiManagerParameter p_url(
  "api_url",
  "Ingest URL (https://.../functions/v1/ingest-reading)",
  "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading",
  199);

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
    if (compresor) luces &= ~(1 << BIT_LED_COMP);
    if (ventilador || OV.compActive || OV.fanActive) luces &= ~(1 << BIT_LED_FORZ);
    if (deshielo) luces &= ~(1 << BIT_LED_DEF);
    if (g_txInProgress && ((millis() / TX_LED_BLINK_MS) % 2) == 0) {
      luces &= ~(1 << BIT_LED_TX);
    }
    if (WiFi.status() == WL_CONNECTED) luces &= ~(1 << BIT_LED_CLOUD);
    enviar4094(activarCom(BIT_COM5), luces);
  }
  if (++digitNow > 4) digitNow = 0;
}

// ============== DISPLAY: TEXTO Y TEMP =======
static String adaptarTexto(String t) {
  t.toUpperCase();
  // El 7-seg no tiene diagonales: M→N y V→U (ej. WIFI OK, ENVIADO, no "ENVIADOS").
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

static void mostrarTextoFijo4(const char *t) {
  for (int i = 0; i < 4; i++) {
    char c = (t && t[i]) ? t[i] : ' ';
    bufferDisplay[i] = mapaChar(c);
  }
}

static uint32_t phaseRemainingS() {
  const uint32_t elapsed = (uint32_t)((millis() - g_phaseStartedAt) / 1000UL);
  if (g_phaseTotalS > elapsed) return g_phaseTotalS - elapsed;
  return 0;
}

/** Etiqueta corta de fase en español (4 caracteres en 7-seg). */
static const char *phaseDisplayLabel(Phase p) {
  switch (p) {
    case PH_DEFROST:      return "DESh";  // deshielo
    case PH_DRIP:         return "GOTE";  // goteo
    case PH_POST_DEFROST: return "ESPE";  // espera post-deshielo
    case PH_NORMAL:       return "FRIO";  // refrigeración
    case PH_BOOT:         return "INIC";  // arranque
    case PH_OFF:          return "APAG";
    case PH_EMERG:        return "ALRM";  // alarma / emergencia
    default:              return "----";
  }
}

static void mostrarFaseActual() {
  mostrarTextoFijo4(phaseDisplayLabel(g_phase));
}

/** Minutos restantes del tramo actual (deshielo, goteo, refrigeración…). */
static void mostrarMinutosRestantesFase() {
  const uint32_t remS = phaseRemainingS();
  const float min = remS / 60.0f;
  mostrarTemperatura(min);
}

static void refreshNormalDisplay() {
  if (g_showSonda2View) {
    if (fault2) mostrarError(2);
    else mostrarTemperatura(tEvap);
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
      if (fault1) mostrarError(1);
      else mostrarTemperatura(tCam);
      break;
  }
}

static void requestManualDefrostFromButton() {
  if (deshielo || dripping) {
    Serial.println(F("[BTN] Ya en deshielo/goteo, no inicio otro."));
    return;
  }
  g_manualDefrostRequested = true;
  g_btnDefrostImmediate = true;
  flashUiMessage("DESh", 800);
  Serial.println(F("[BTN] Deshielo manual solicitado (UP mantenido)."));
  if (P.F35 < 0.5f) {
    Serial.println(F("[BTN] Nota: AR46=0 en parametros; el boton fisico igual fuerza deshielo."));
  }
}

static void printLittleFsReport() {
  if (!ensureFs()) {
    Serial.println(F("[MEM] LittleFS no disponible."));
    return;
  }
  size_t total = LittleFS.totalBytes();
  size_t used = LittleFS.usedBytes();
  Serial.println(F("---- MEMORIA LittleFS (ESP32) ----"));
  Serial.printf("Total: %u bytes | Usado: %u | Libre: %u\n",
                (unsigned)total, (unsigned)used, (unsigned)(total - used));
  auto printFile = [](const char *path) {
    if (!LittleFS.exists(path)) {
      Serial.printf("  %s: (no existe)\n", path);
      return;
    }
    File f = LittleFS.open(path, "r");
    Serial.printf("  %s: %u bytes\n", path, (unsigned)f.size());
    f.close();
  };
  printFile(CFG_PATH);
  printFile(PARAMS_PATH);
  printFile(CMDTS_PATH);
  Serial.println(F("Historial de lecturas: NO se guarda en el ESP."));
  Serial.println(F("Cada TX va directo a Supabase (ingest-reading); no llena flash local."));
  Serial.printf("Telemetria cada %lu ms (~%lu puntos/hora por equipo).\n",
                  (unsigned long)g_cfg.intervalMs,
                  (unsigned long)(3600000UL / g_cfg.intervalMs));
  Serial.printf("Fase: %s | Transcurrido: %lus | Total tramo: %lus | Faltan: %lus\n",
                phaseName(g_phase),
                (unsigned long)((millis() - g_phaseStartedAt) / 1000UL),
                (unsigned long)g_phaseTotalS,
                (unsigned long)phaseRemainingS());
  Serial.printf("Temp cam=%.1f evap=%.1f | comp=%d vent=%d def=%d drip=%d\n",
                tCam, tEvap, compresor ? 1 : 0, ventilador ? 1 : 0,
                deshielo ? 1 : 0, dripping ? 1 : 0);
  Serial.println(F("--------------------------------"));
}

static bool btnPressed(int pin) {
#if BTN_ACTIVE_LOW
  return digitalRead(pin) == LOW;
#else
  return digitalRead(pin) == HIGH;
#endif
}

/** Pull explícito: GPIO14/16/17 a veces no levantan bien solo con pinMode(). */
static void initBtnPin(int pin) {
  gpio_reset_pin((gpio_num_t)pin);
  gpio_set_direction((gpio_num_t)pin, GPIO_MODE_INPUT);
#if BTN_ACTIVE_LOW
  gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLUP_ONLY);
#else
  gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLDOWN_ONLY);
#endif
}

static void printBtnDiag() {
  Serial.printf("[BTN] Pines U=%d D=%d S=%d B=%d | activo_%s\n",
                BTN_UP_PIN, BTN_DOWN_PIN, BTN_SET_PIN, BTN_BACK_PIN,
                BTN_ACTIVE_LOW ? "bajo" : "alto");
  Serial.printf("  raw HIGH/LOW: U=%d D=%d S=%d B=%d\n",
                digitalRead(BTN_UP_PIN), digitalRead(BTN_DOWN_PIN),
                digitalRead(BTN_SET_PIN), digitalRead(BTN_BACK_PIN));
  Serial.printf("  logica apretado: U=%d D=%d S=%d B=%d | ui=%d waitRel=%d\n",
                btnPressed(BTN_UP_PIN) ? 1 : 0,
                btnPressed(BTN_DOWN_PIN) ? 1 : 0,
                btnPressed(BTN_SET_PIN) ? 1 : 0,
                btnPressed(BTN_BACK_PIN) ? 1 : 0,
                (int)g_uiMode, g_menuWaitRelease ? 1 : 0);
  Serial.println(F("  Apretá cada botón: raw debe cambiar. Si apretado=HIGH, BTN_ACTIVE_LOW=0."));
}

static void syncBtnPrevFromPins() {
  const int pins[4] = {BTN_UP_PIN, BTN_DOWN_PIN, BTN_SET_PIN, BTN_BACK_PIN};
  for (int i = 0; i < 4; i++) g_btnPrev[i] = btnPressed(pins[i]);
}

static bool anyBtnPressed() {
  return btnPressed(BTN_UP_PIN) || btnPressed(BTN_DOWN_PIN) ||
         btnPressed(BTN_SET_PIN) || btnPressed(BTN_BACK_PIN);
}

static void pushFlash(uint8_t kind) {
  if (kind == FP_NONE) return;
  const uint8_t cur = g_flashPending;
  if (cur == FP_NONE || kind < cur) g_flashPending = kind;
}

static const char *flashMsgText(uint8_t kind) {
  switch (kind) {
    case FP_WIFI:     return "WIFI OK   ";
    case FP_CALOR:    return "CALOR     ";
    case FP_ENVIADO:  return "ENVIADO   ";
    case FP_PARAM:    return "PARAM OK  ";
    case FP_ENVIANDO: return "ENVIANDO  ";
    default:          return "        ";
  }
}

static unsigned long flashMsgDurationMs(uint8_t kind) {
  switch (kind) {
    case FP_ENVIANDO: return 1400UL;
    case FP_WIFI:
    case FP_CALOR:    return 3200UL;
    default:          return 3800UL;
  }
}

static void flashUiMessage(const char *msg, unsigned long ms = 1200UL) {
  modoTexto = true;
  texto = msg;
  scrollPos = 0;
  prepararTexto();
  g_flashActive = true;
  g_flashEndsAt = millis() + ms;
}

/** Marquesina del portal: el loop queda bloqueado en WiFiManager → scroll acá. */
static void portalDisplayTick(unsigned long now) {
  if (!g_portalRunning || !modoTexto) return;
  if (now - g_portalScrollAt >= 300UL) {
    g_portalScrollAt = now;
    prepararTexto();
  }
}

static void restoreDisplayAfterPortal() {
  if (WiFi.status() == WL_CONNECTED) {
    if (g_flashPending == FP_NONE && !g_flashActive) pushFlash(FP_WIFI);
    return;
  }
  modoTexto = false;
  g_flashActive = false;
  g_flashPending = FP_NONE;
  refreshNormalDisplay();
}

/** Consume un mensaje pendiente o mantiene el scroll activo. */
static void serviceUiFlash(unsigned long now) {
  if (g_flashActive && now < g_flashEndsAt) {
    if (modoTexto && now - lastScroll >= 300) {
      lastScroll = now;
      prepararTexto();
    }
    return;
  }
  const uint8_t pending = g_flashPending;
  if (pending != FP_NONE) {
    g_flashPending = FP_NONE;
    flashUiMessage(flashMsgText(pending), flashMsgDurationMs(pending));
    return;
  }
  if (g_flashActive) {
    g_flashActive = false;
    modoTexto = false;
  }
}

/** En 40 °C ambiente el ESP se calienta: bajar potencia WiFi y avisar en display. */
static void aplicarDeratingPorCalor(unsigned long now) {
  const float chipC = temperatureRead();
  const bool hotChip = chipC >= CHIP_TEMP_WARN_C;
  const bool hotCam  = !fault1 && (tCam >= CAMBIENT_HOT_C);
  if (hotChip || hotCam) {
    g_hotDerateUntilMs = now + 120000UL;
    WiFi.setTxPower(WIFI_POWER_7dBm);
    if (now - g_lastCalorFlashMs >= 90000UL) {
      g_lastCalorFlashMs = now;
      pushFlash(FP_CALOR);
      Serial.printf("[CALOR] chip=%.0fC sonda=%.1fC → WiFi suave (ventilá el gabinete)\n",
                    chipC, tCam);
    }
  } else if (g_hotDerateUntilMs != 0 && now >= g_hotDerateUntilMs) {
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    g_hotDerateUntilMs = 0;
  }
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

// Implementación real más abajo (se reutiliza para persistir cambios desde botones).
static bool saveParams(JsonObject obj);

static void showParamCodeOnDisplay(const char *code) {
  for (int i = 0; i < 4; i++) bufferDisplay[i] = BLANCO;
  bufferDisplay[0] = mapaChar('A');
  bufferDisplay[1] = mapaChar(code[0]);
  bufferDisplay[2] = mapaChar(code[1]);
}

static bool saveCurrentParamsToFs() {
  StaticJsonDocument<4096> doc;
  JsonObject p = doc.createNestedObject("params");
  #define STORE(K) p[#K] = P.K
  STORE(F01); STORE(F02); STORE(F03); STORE(F04); STORE(F05);
  STORE(F06); STORE(F07); STORE(F08); STORE(F09); STORE(F10);
  STORE(F11); STORE(F12); STORE(F13); STORE(F14); STORE(F15);
  STORE(F16); STORE(F17); STORE(F18); STORE(F19); STORE(F20);
  STORE(F25); STORE(F26); STORE(F27); STORE(F28); STORE(F29);
  STORE(F30); STORE(F31); STORE(F32); STORE(F33); STORE(F34);
  STORE(F35); STORE(F36); STORE(F37); STORE(F38); STORE(F39);
  STORE(F40); STORE(F45); STORE(F46); STORE(F47); STORE(F48);
  STORE(F49); STORE(F50); STORE(F51); STORE(F52); STORE(F52t);
  STORE(F53); STORE(F54); STORE(F55);
  #undef STORE
  return saveParams(p);
}

static float clampParamValue(float v, float minV, float maxV) {
  if (v < minV) v = minV;
  if (v > maxV) v = maxV;
  return v;
}

/** SET + (ABAJO, UP o VOLVER): abre portal. SET+ABAJO es el más fácil en el panel. */
static bool portalComboHeldNow() {
  if (!btnPressed(BTN_SET_PIN)) return false;
  if (btnPressed(BTN_DOWN_PIN)) return true;
  if (btnPressed(BTN_UP_PIN) && !btnPressed(BTN_DOWN_PIN)) return true;
  if (btnPressed(BTN_BACK_PIN) && !btnPressed(BTN_UP_PIN) && !btnPressed(BTN_DOWN_PIN)) return true;
  return false;
}

static bool handlePortalComboHold(unsigned long now) {
  if (g_wifiState == WFS_PORTAL || g_portalRunning) return true;
  if (portalComboHeldNow()) {
    g_portalComboReleasedAt = 0;
    if (g_portalComboHeldAt == 0) g_portalComboHeldAt = now;
    const unsigned long held = now - g_portalComboHeldAt;
    if (!g_portalHoldHintShown && held >= 300UL) {
      g_portalHoldHintShown = true;
      flashUiMessage("WIFI...   ", 900);
      Serial.println(F("[BTN] Mantené SET+ABAJO (o SET+UP / SET 4s)..."));
    }
    if (held >= BTN_WIFI_PORTAL_HOLD_MS) {
      g_portalComboHeldAt = 0;
      g_portalHoldHintShown = false;
      g_uiMode = UI_NORMAL;
      g_menuWaitRelease = true;
      syncBtnPrevFromPins();
      runConfigPortal();
      Serial.println(F("[BTN] Combo → portal WiFi PRO300-Setup."));
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
  const bool upHeld = btnPressed(BTN_UP_PIN);
  const bool downHeld = btnPressed(BTN_DOWN_PIN);
  const bool setHeld = btnPressed(BTN_SET_PIN);

  if (handlePortalComboHold(now)) return;
  if (g_wifiState == WFS_PORTAL || g_portalRunning) return;

  if (g_uiMode == UI_NORMAL) {
    if (!g_flashActive && g_flashPending == FP_NONE && !g_portalRunning) modoTexto = false;
    const bool upEdgeEarly = consumePressEdge(BTN_UP_PIN, 0, now);
    const bool downEdgeEarly = consumePressEdge(BTN_DOWN_PIN, 1, now);
    const bool setEdgeEarly = consumePressEdge(BTN_SET_PIN, 2, now);
    const bool backEdgeEarly = consumePressEdge(BTN_BACK_PIN, 3, now);

    if (backEdgeEarly && !upHeld && !downHeld && !setHeld) {
      g_showSonda2View = !g_showSonda2View;
      refreshNormalDisplay();
      Serial.printf("[BTN] Sonda 2 (evaporador): %s\n", g_showSonda2View ? "SI" : "NO (vuelve S1/ciclo)");
      syncBtnPrevFromPins();
      return;
    }

    if (upEdgeEarly && (deshielo || dripping)) {
      g_manualCancelDefrost = true;
      flashUiMessage("STOP", 900);
      Serial.println(F("[BTN] UP toque: cancelar deshielo → goteo."));
      syncBtnPrevFromPins();
      return;
    }

    if (downEdgeEarly && !upHeld && !setHeld) {
      g_showSonda2View = false;
      g_normalDisp = (NormalDispMode)(((int)g_normalDisp + 1) % 3);
      refreshNormalDisplay();
      Serial.printf("[BTN] Vista=%d (0=S1 1=fase 2=min; VOLVER=S2)\n", (int)g_normalDisp);
      syncBtnPrevFromPins();
      return;
    }

    if (setEdgeEarly && !upHeld && !downHeld) {
      g_uiMode = UI_PARAM_SELECT;
      g_paramCursor = 0;
      g_menuWaitRelease = true;
      syncBtnPrevFromPins();
      showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
      flashUiMessage("MENU", 800);
      Serial.println(F("[BTN] SET toque → menu parametros (A01)."));
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
        Serial.println(F("[BTN] Menu parametros (A01). Soltá todos y usá SET."));
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
        Serial.println(F("[BTN] SET 4s → portal WiFi."));
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
        Serial.println(F("[BTN] Menu por SET largo (A01). Soltá o seguí 4s para WiFi."));
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
    Serial.println(F("[BTN] Botones liberados — SET activo."));
  }

  modoTexto = false;
  const bool upEdge = consumePressEdge(BTN_UP_PIN, 0, now);
  const bool downEdge = consumePressEdge(BTN_DOWN_PIN, 1, now);
  const bool setEdge = consumePressEdge(BTN_SET_PIN, 2, now);
  const bool backEdge = consumePressEdge(BTN_BACK_PIN, 3, now);

  if (setEdge) {
    Serial.printf("[BTN] SET GPIO%d | U%d D%d S%d B%d\n",
                  BTN_SET_PIN,
                  btnPressed(BTN_UP_PIN) ? 1 : 0,
                  btnPressed(BTN_DOWN_PIN) ? 1 : 0,
                  btnPressed(BTN_SET_PIN) ? 1 : 0,
                  btnPressed(BTN_BACK_PIN) ? 1 : 0);
  }

  if (g_uiMode == UI_PARAM_SELECT) {
    if (upEdge) {
      g_paramCursor = (g_paramCursor + 1) % PARAM_MENU_COUNT;
    } else if (downEdge) {
      g_paramCursor = (g_paramCursor - 1 + PARAM_MENU_COUNT) % PARAM_MENU_COUNT;
    }
    if (upEdge || downEdge) showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
    if (setEdge) {
      g_paramEditOriginal = *g_paramMenu[g_paramCursor].value;
      g_uiMode = UI_PARAM_EDIT;
      mostrarTemperatura(*g_paramMenu[g_paramCursor].value);
      flashUiMessage("EDIT", 600);
      Serial.printf("[BTN] Editando A%s = %.2f\n", g_paramMenu[g_paramCursor].code,
                    *g_paramMenu[g_paramCursor].value);
    }
    if (backEdge) {
      g_uiMode = UI_NORMAL;
      g_normalDisp = DISP_TEMP;
      g_showSonda2View = false;
      Serial.println(F("[BTN] Saliendo de menu parametros."));
    }
    return;
  }

  if (g_uiMode == UI_PARAM_EDIT) {
    ParamMenuItem &it = g_paramMenu[g_paramCursor];
    bool valueChanged = false;
    if (upEdge) {
      *it.value = clampParamValue(*it.value + it.step, it.minValue, it.maxValue);
      valueChanged = true;
      g_editRepeatAt = now;
    } else if (downEdge) {
      *it.value = clampParamValue(*it.value - it.step, it.minValue, it.maxValue);
      valueChanged = true;
      g_editRepeatAt = now;
    } else if (upHeld && now - g_editRepeatAt >= BTN_EDIT_REPEAT_MS) {
      *it.value = clampParamValue(*it.value + it.step, it.minValue, it.maxValue);
      valueChanged = true;
      g_editRepeatAt = now;
    } else if (downHeld && now - g_editRepeatAt >= BTN_EDIT_REPEAT_MS) {
      *it.value = clampParamValue(*it.value - it.step, it.minValue, it.maxValue);
      valueChanged = true;
      g_editRepeatAt = now;
    }
    if (valueChanged) mostrarTemperatura(*it.value);
    if (setEdge) {
      const bool ok = saveCurrentParamsToFs();
      g_uiMode = UI_PARAM_SELECT;
      showParamCodeOnDisplay(it.code);
      flashUiMessage(ok ? "SAVE" : "ERR", 900);
      Serial.printf("[BTN] A%s guardado: %.2f (%s)\n", it.code, *it.value, ok ? "OK" : "ERROR");
    }
    if (backEdge) {
      *it.value = g_paramEditOriginal;
      g_uiMode = UI_PARAM_SELECT;
      showParamCodeOnDisplay(it.code);
      Serial.printf("[BTN] A%s cancelado, vuelve a %.2f\n", it.code, *it.value);
    }
  }
}

// ============== LECTURA NTC =================
/**
 * AR08 (F54) decide cuántas muestras tomamos por lectura (4–32). Aceptamos
 * más muestras = lectura más estable pero más lenta. Saturamos los extremos
 * para no quedarnos sin tiempo de loop si llega un valor raro de la nube.
 */
static float rNtcFromAdc(int adc) {
#if NTC_R_SERIES_TO_VCC
  return R_FIXED * ((float)adc / (4095.0f - (float)adc));
#else
  return R_FIXED * ((4095.0f - (float)adc) / (float)adc);
#endif
}

static float tempCFromAdc(int adc) {
  const float rNTC = rNtcFromAdc(adc);
  if (rNTC <= 1.0f || rNTC > 500000.0f) return TEMP_ERR_VALUE;
  const float tK = 1.0f / ((1.0f / T0K) + (1.0f / BETA) * log(rNTC / R0));
  return tK - 273.15f;
}

/** Misma lectura ADC con el divisor opuesto (para diagnosticar cableado). */
static float tempCFromAdcAlt(int adc) {
#if NTC_R_SERIES_TO_VCC
  const float rNTC = R_FIXED * ((4095.0f - (float)adc) / (float)adc);
#else
  const float rNTC = R_FIXED * ((float)adc / (4095.0f - (float)adc));
#endif
  if (rNTC <= 1.0f || rNTC > 500000.0f) return TEMP_ERR_VALUE;
  const float tK = 1.0f / ((1.0f / T0K) + (1.0f / BETA) * log(rNTC / R0));
  return tK - 273.15f;
}

static int leerAdcPromedio(int pin, bool &rawFault) {
  int samples = (int)P.F54;
  if (samples < 4)  samples = 4;
  if (samples > 32) samples = 32;
  long acc = 0;
  int validas = 0;
  for (int i = 0; i < samples; i++) {
    const int v = analogRead(pin);
    if (v > 8 && v < 4088) { acc += v; validas++; }
    delayMicroseconds(250);
  }
  if (validas < samples / 2) {
    rawFault = true;
    return -1;
  }
  rawFault = false;
  return (int)(acc / validas);
}

static float leerNTCpromedio(int pin, bool &rawFault, float offset) {
  const int adc = leerAdcPromedio(pin, rawFault);
  if (rawFault || adc < 0) return TEMP_ERR_VALUE;
  const float tC = tempCFromAdc(adc);
  if (!tempRollSampleValid(tC)) {
    rawFault = true;
    return TEMP_ERR_VALUE;
  }
  rawFault = false;
  return tC + offset;
}

static float promedioMovilTemp(const float *hist, uint8_t fill) {
  if (fill == 0) return TEMP_ERR_VALUE;
  float sum = 0.0f;
  int n = 0;
  for (uint8_t i = 0; i < fill; i++) {
    if (tempRollSampleValid(hist[i])) {
      sum += hist[i];
      n++;
    }
  }
  return n > 0 ? (sum / (float)n) : TEMP_ERR_VALUE;
}

static void pushTempRoll(float rawCam, float rawEvap) {
  if (tempRollSampleValid(rawCam)) tCamRoll[tRollIdx] = rawCam;
  if (tempRollSampleValid(rawEvap)) tEvapRoll[tRollIdx] = rawEvap;
  tRollIdx = (uint8_t)((tRollIdx + 1) % TEMP_ROLL_AVG_N);
  if (tRollFill < TEMP_ROLL_AVG_N) tRollFill++;
}

static void printNtcSondaLine(const char *label, int pin, int adc, bool rf, float disp, bool fault) {
  if (adc < 0) {
    Serial.printf("  %s GPIO%d sin lectura valida (cable suelto?)\n", label, pin);
    return;
  }
  const float tAct = tempCFromAdc(adc);
  const float tAlt = tempCFromAdcAlt(adc);
  Serial.printf("  %s GPIO%d ADC=%d R=%.0f ohm T=%.2f C (alt=%.2f C) rawFault=%d disp=%.2f fault=%d\n",
                label, pin, adc, rNtcFromAdc(adc), tAct, tAlt, rf ? 1 : 0, disp, fault ? 1 : 0);
  if (adc < 50) {
    Serial.println(F("       -> ADC muy bajo: revisar cable / pin correcto (S1=34 S2=35)"));
  } else if (adc > 3900) {
    Serial.println(F("       -> ADC saturado: corto o divisor mal cableado"));
  } else if (tAct > -6.0f && tAct < 6.0f && tAlt > 12.0f && tAlt < 40.0f) {
    Serial.println(F("       -> ~0 C con formula activa pero ~ambiente con alt: cambiar NTC_R_SERIES_TO_VCC"));
  }
}

static void printNtcDiag() {
  bool f1 = false, f2 = false;
  const int adc1 = leerAdcPromedio(NTC1_PIN, f1);
  const int adc2 = leerAdcPromedio(NTC2_PIN, f2);
  Serial.printf("[NTC] divisor activo: %s | AR03=%.1f AR04=%.1f | AR08=%.0f muestras\n",
                NTC_R_SERIES_TO_VCC ? "3V3-10k-ADC-NTC-GND" : "3V3-NTC-ADC-10k-GND",
                P.F03, P.F04, P.F54);
  Serial.println(F("[NTC] Pantalla: SET cicla vista; VOLVER = ver S2. Comando serie: temp"));
  printNtcSondaLine("S1", NTC1_PIN, adc1, f1, tCam, fault1);
  printNtcSondaLine("S2", NTC2_PIN, adc2, f2, tEvap, fault2);
}

static void updateNtcFaultDebounced(bool raw1, bool raw2) {
  if (raw1) {
    if (ntcBadStreak1 < 255) ntcBadStreak1++;
    ntcGoodStreak1 = 0;
    if (ntcBadStreak1 >= NTC_FAULT_SET_COUNT) fault1 = true;
  } else {
    if (ntcGoodStreak1 < 255) ntcGoodStreak1++;
    ntcBadStreak1 = 0;
    if (ntcGoodStreak1 >= NTC_FAULT_CLR_COUNT) {
      if (fault1) resetTempRollBuffers();
      fault1 = false;
    }
  }
  if (raw2) {
    if (ntcBadStreak2 < 255) ntcBadStreak2++;
    ntcGoodStreak2 = 0;
    if (ntcBadStreak2 >= NTC_FAULT_SET_COUNT) fault2 = true;
  } else {
    if (ntcGoodStreak2 < 255) ntcGoodStreak2++;
    ntcBadStreak2 = 0;
    if (ntcGoodStreak2 >= NTC_FAULT_CLR_COUNT) {
      if (fault2) resetTempRollBuffers();
      fault2 = false;
    }
  }
  const bool ctrlRawOk = (P.F53 >= 0.5f) ? !raw2 : !raw1;
  if (ctrlRawOk) ntcReady = true;
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
  // termina el deshielo, marca fin de calor y pasa al goteo.
  // deshielo activo, el flag se descarta silenciosamente.
  if (g_manualCancelDefrost) {
    g_manualCancelDefrost = false;
    if (deshielo) {
      deshielo = false;
      lastDefrostHeatOffAt = now;
      dripping = true;
      dripStartedAt = now;
      if (compresor) { compresor = false; compChangedAt = now; }
      setPhase(PH_DRIP, (uint32_t)(P.F39 * 60.0f));
      Serial.println(F("[CMD] deshielo cancelado por usuario, paso a goteo."));
      return;
    }
  }

  // Arranque: relés OFF solo durante AR14 (mín. RELAY_BOOT_MIN_MS). Luego sale de INIC
  // aunque la sonda falle (ver E1/E2 en display y AR34).
  if (now < relaySafeUntilMs) {
    compresor = ventilador = deshielo = dripping = false;
    emergencyComp = false;
    const uint32_t remS = (uint32_t)((relaySafeUntilMs - now + 999UL) / 1000UL);
    setPhase(PH_BOOT, remS > 0 ? remS : 1);
    return;
  }
  if (!ntcReady) ntcReady = true;

  // F38: fin del retardo de encendido (AR14); luego puede F09 deshielo al arranque.
  if (!bootDelayDone) {
    bootDelayDone = true;
    compChangedAt = now;
    lastDefrostAt = now;
    Serial.printf("[BOOT] Fin retardo AR14=%.0fs — control normal (sonda OK).\n", P.F38);
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
    // Primeros segundos tras encender: no ciclar relés por ADC inestable (no quedarse en INIC).
    if ((now - bootAtMs) < SENSOR_FAULT_GRACE_MS) {
      if (compresor) { compresor = false; compChangedAt = now; }
      ventilador = false;
      deshielo = false;
      emergencyComp = false;
      setPhase(PH_OFF, 0);
      return;
    }
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
  bool manualBypassStartup =
      g_btnDefrostImmediate || (g_manualDefrostRequested && (P.F37 >= 0.5f));
  bool startDefrost = !deshielo && !dripping &&
      (manualBypassStartup ||
       (!defrostBlockedByStartup &&
        (defrostByInterval || forceDefrost || defrostByIce || g_manualDefrostRequested)));
  if (g_manualDefrostRequested && startDefrost) {
    g_manualDefrostRequested = false;
    g_btnDefrostImmediate = false;
  } else if (g_manualDefrostRequested && (deshielo || dripping)) {
    // Ya hay un ciclo activo, descartamos el pedido manual.
    g_manualDefrostRequested = false;
    g_btnDefrostImmediate = false;
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
      lastDefrostHeatOffAt = now;
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
      lastDefrostAt = now;
      Serial.println(F("[DEF] Goteo OK → cuenta AR10 (intervalo) desde ahora."));
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
  bool postDefGate = (now - lastDefrostHeatOffAt) >= postDefDelayMs;
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
    // como F06*60 - (millis() - lastDefrostAt) (lastDefrostAt = fin goteo)
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
  if (!cloudCredentialsReady()) {
    Serial.println(F("[PULL] sin moduleId/apiKey, salto (modo local)."));
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
      JsonObject cmd = cmdVar.as<JsonObject>();
      const char *ts = cmd["ts"] | "";
      if (ts[0] && g_lastCmdTs == ts) {
        Serial.println(F("[PULL] pending_command ya aplicado (mismo ts), fin ventana urgente."));
        g_pullUrgentUntilMs = 0;
      } else {
        Serial.println(F("[PULL] respuesta trae pending_command, lo proceso."));
        applyPendingCommand(cmd);
        if (ts[0] && g_lastCmdTs == ts) {
          g_pullUrgentUntilMs = 0;
        } else {
          requestUrgentPullWindow();
        }
      }
    } else {
      Serial.println(F("[PULL] respuesta sin pending_command."));
      g_pullUrgentUntilMs = 0;
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
  pushFlash(FP_PARAM);
}

// ============== Portal WiFiManager ==========
static void portalWdtRelax(bool relax) {
#if defined(ESP_IDF_VERSION_MAJOR) && ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t cfg = {
    .timeout_ms     = relax ? PORTAL_WDT_TIMEOUT_MS : 30000,
    .idle_core_mask = 0,
    .trigger_panic  = true,
  };
  esp_task_wdt_reconfigure(&cfg);
#else
  (void)relax;
#endif
}

static void copyPortalConfigAndSave() {
  const char *mid = p_module.getValue();
  const char *tok = p_token.getValue();
  const char *u   = p_url.getValue();
  if (mid && mid[0]) strlcpy(g_cfg.moduleId, mid, sizeof(g_cfg.moduleId));
  if (tok && tok[0]) strlcpy(g_cfg.apiKey, tok, sizeof(g_cfg.apiKey));
  if (u && strncmp(u, "https://", 8) == 0 && strstr(u, "/functions/v1/")) {
    strlcpy(g_cfg.apiUrl, u, sizeof(g_cfg.apiUrl));
  } else if (u && u[0]) {
    Serial.println(F("[CFG] URL ignorada (debe ser https://.../functions/v1/...)"));
  }
  saveConfig();
  Serial.printf("[CFG] Guardado: module=%s url=%s\n", g_cfg.moduleId, g_cfg.apiUrl);
}

static bool connectSavedWifi(unsigned long timeoutMs) {
  Serial.printf("[WiFi] Conectando (máx. %lu ms)...\n", timeoutMs);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  if (WiFi.SSID().length() == 0) {
    Serial.println(F("[WiFi] No hay SSID guardado — abrí el portal y guardá de nuevo."));
    return false;
  }
  Serial.printf("[WiFi] SSID guardado: %s\n", WiFi.SSID().c_str());
  WiFi.disconnect(false);
  delay(100);
  WiFi.begin();
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < timeoutMs) {
    delay(250);
    yield();
    esp_task_wdt_reset();
    const wl_status_t st = WiFi.status();
    if (st == WL_CONNECT_FAILED || st == WL_NO_SSID_AVAIL) {
      Serial.printf("[WiFi] Falló conexión (status=%d). Revisá SSID/clave.\n", (int)st);
      break;
    }
  }
  const bool ok = (WiFi.status() == WL_CONNECTED);
  if (ok) {
    Serial.printf("[WiFi] OK IP=%s RSSI=%d\n",
                  WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    g_prevWifiConnected = true;
    pushFlash(FP_WIFI);
  } else {
    Serial.printf("[WiFi] Sin conectar (status=%d).\n", (int)WiFi.status());
  }
  return ok;
}

/**
 * Portal bloqueante (display sigue en displayTask). WiFiManager guarda SSID/clave
 * en flash al pulsar Save y prueba la conexión antes de volver.
 */
static void runConfigPortal() {
  Serial.println(F("[WiFi] Abriendo portal (bloqueante)..."));
  portalWdtRelax(true);
  g_wifiState = WFS_PORTAL;
  g_portalRunning = true;
  g_portalSaveRequested = false;

  wm.stopConfigPortal();
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.disconnect(true, false);
  delay(200);
  WiFi.mode(WIFI_AP_STA);

  wm.setBreakAfterConfig(true);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_SEC);
  wm.setConfigPortalBlocking(true);
  wm.setConnectTimeout(45);
  wm.setSaveConnectTimeout(45);
  wm.setMinimumSignalQuality(-1);
  wm.setShowPassword(true);
  wm.setCaptivePortalEnable(true);

  modoTexto = true;
  texto = "WIFI PRO300 SETUP 192.168.4.1 SAVE ";
  scrollPos = 4;
  prepararTexto();
  g_portalScrollAt = millis();
  Serial.printf("[WiFi] Celular → red '%s' → http://192.168.4.1 → Save\n", AP_NAME);

  const bool portalOk = wm.startConfigPortal(AP_NAME);
  Serial.printf("[WiFi] Portal cerrado ok=%d status=%d\n", portalOk ? 1 : 0, (int)WiFi.status());

  if (g_portalSaveRequested) {
    copyPortalConfigAndSave();
    g_portalSaveRequested = false;
  }

  wm.stopConfigPortal();
  WiFi.softAPdisconnect(true);
  g_portalRunning = false;
  g_wifiState = WFS_RUNNING;
  portalWdtRelax(false);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[WiFi] Tras guardar no conectó; reintento STA..."));
    connectSavedWifi(30000UL);
  }

  restoreDisplayAfterPortal();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[WiFi] Revisá: 2.4 GHz, clave correcta, sin espacios extra en SSID."));
  }
}

static bool cloudCredentialsReady() {
  return strlen(g_cfg.moduleId) > 0 && strlen(g_cfg.apiKey) >= 6;
}

static void setupWifi() {
  WiFi.setSleep(false);
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  wm.setConnectTimeout(45);
  wm.setSaveConnectTimeout(45);
  wm.setMinimumSignalQuality(-1);
  wm.setSaveConfigCallback([]() { g_portalSaveRequested = true; });
  p_module.setValue(g_cfg.moduleId, sizeof(g_cfg.moduleId) - 1);
  p_token.setValue(g_cfg.apiKey,    sizeof(g_cfg.apiKey)    - 1);
  p_url.setValue(g_cfg.apiUrl,      sizeof(g_cfg.apiUrl)    - 1);
  wm.addParameter(&p_module);
  wm.addParameter(&p_token);
  wm.addParameter(&p_url);

  const bool forcePortal = digitalRead(PIN_FORCE_PORTAL) == LOW;
  if (forcePortal) {
    Serial.println(F("[WiFi] BOOT a GND → portal forzado."));
    runConfigPortal();
    return;
  }

  if (!cloudCredentialsReady()) {
    Serial.println(F("[WiFi] Sin module_id/api_key → modo local (portal: SET+ABAJO 1s)."));
  }

  if (WiFi.SSID().length() > 0) {
    if (!connectSavedWifi(WIFI_BOOT_CONNECT_MS)) {
      Serial.println(F("[WiFi] No conectó en boot. Control local activo; reintento cada 30 s."));
      g_prevWifiConnected = false;
    } else {
      Serial.printf("[WiFi] OK: SSID=%s IP=%s RSSI=%d\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
      g_prevWifiConnected = true;
      if (cloudCredentialsReady()) pushFlash(FP_WIFI);
    }
  } else {
    Serial.println(F("[WiFi] Sin SSID guardado. Control local; WiFi opcional (portal manual)."));
    g_prevWifiConnected = false;
    WiFi.mode(WIFI_STA);
  }

  g_wifiState = WFS_RUNNING;
}
// Reintento de WiFi vive ahora en networkTask() (core 0).

// ============== Telemetría ==================
static void enviarTelemetria() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!cloudCredentialsReady()) return;
  g_txInProgress = true;
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
    // por intervalo (F06 min desde fin de goteo = lastDefrostAt). Calculamos al
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
  g_txInProgress = false;
  if (code != 200) return;

  // Atajo de propagación: si el server nos cuenta que `params_updated_at` del
  // combistato es más nuevo que el que tenemos, pedimos un pull inmediato.
  // Así editás un AR en la app y a los pocos segundos lo aplica el equipo.
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, resp) == DeserializationError::Ok) {
    if (doc["pull_params_now"] | false) {
      requestUrgentPullWindow();
    }
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
  Serial.printf("AR14 F38 boot delay   = %.0f s (min %lu s en relés)\n",
                P.F38, (unsigned long)(RELAY_BOOT_MIN_MS / 1000UL));
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

  if (lower == "portal" || lower == "wifi")  { runConfigPortal(); return; }
  if (lower == "reset")   { Serial.println(F("Reseteando config...")); resetConfig(); return; }
  if (lower == "config")  { printConfig(); return; }
  if (lower == "reboot")  { ESP.restart(); return; }
  if (lower == "temp")    { modoTexto = false; return; }
  if (lower == "ntc" || lower == "adc") {
    printNtcDiag();
    return;
  }
  if (lower == "pull")    { Serial.println(F("[PULL] solicitando pull a la task de red...")); g_pullNowRequested = true; return; }
  if (lower == "btns" || lower == "buttons" || lower == "btn") {
    printBtnDiag();
    return;
  }
  if (lower == "mem" || lower == "diag" || lower == "status") {
    printLittleFsReport();
    return;
  }
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
    portalDisplayTick(millis());
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

    if (g_wifiState == WFS_RUNNING && !g_portalRunning) {
      const bool wifiOk = (WiFi.status() == WL_CONNECTED);
      if (wifiOk && !g_prevWifiConnected) {
        g_prevWifiConnected = true;
        pushFlash(FP_WIFI);
        Serial.printf("[WiFi] Conectado: %s IP=%s\n",
                      WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
      } else if (!wifiOk && g_prevWifiConnected) {
        g_prevWifiConnected = false;
        Serial.println(F("[WiFi] Desconectado."));
      }

      // Reintentar WiFi si se cayó.
      if (!wifiOk) {
        if (lastRetry == 0 || (millis() - lastRetry) >= 30000UL) {
          lastRetry = millis();
          Serial.println(F("[WiFi] Reintentando (task)..."));
          WiFi.disconnect(false);
          delay(80);
          WiFi.mode(WIFI_STA);
          WiFi.begin();
        }
      } else {
        // TX baseline cada g_cfg.intervalMs (60 s) + TX inmediato cuando el
        // loop detecta un cambio de relé / fase / puerta. El rate-limit de
        // IMMEDIATE_TX_MIN_GAP_MS evita que un relé que chattea reviente la
        // cuota Free. Si el evento llega y el gap todavía no pasó, el flag
        // queda pendiente y se sirve en el próximo tick (200 ms).
        const unsigned long nowMs = millis();
        bool sendNow = false;
        unsigned long telEvery = g_cfg.intervalMs;
        if (temperatureRead() >= CHIP_TEMP_WARN_C) {
          telEvery = max(telEvery, 120000UL);
        }
        if (nowMs - lastTel >= telEvery) {
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
  initBtnPin(BTN_UP_PIN);
  initBtnPin(BTN_DOWN_PIN);
  initBtnPin(BTN_SET_PIN);
  initBtnPin(BTN_BACK_PIN);
  if (DOOR_PIN >= 0) initBtnPin(DOOR_PIN);
  syncBtnPrevFromPins();
  printBtnDiag();
  analogReadResolution(12);
  analogSetPinAttenuation(NTC1_PIN, ADC_11db);
  analogSetPinAttenuation(NTC2_PIN, ADC_11db);
  resetTempRollBuffers();

  SPI.begin(CLOCK_PIN, -1, DATA_PIN, -1);
  // Inicializa los 4094 con todo apagado. Cerramos la transacción para
  // liberar el mutex interno del SPI; si no, displayTask se queda esperando
  // para siempre cuando intenta su propio beginTransaction() → display negro.
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  enviar4094(comunesApagados(), 0xFF);
  SPI.endTransaction();

  Serial.println();
  Serial.println(F("AR Monitoreo PRO300 booteando..."));
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
  {
    unsigned long holdMs = (unsigned long)(P.F38 * 1000.0f);
    if (holdMs < RELAY_BOOT_MIN_MS) holdMs = RELAY_BOOT_MIN_MS;
    relaySafeUntilMs = bootAtMs + holdMs;
  }
  ntcReady = false;
  ntcBadStreak1 = ntcBadStreak2 = 0;
  ntcGoodStreak1 = ntcGoodStreak2 = 0;
  fault1 = fault2 = false;
  bootDelayDone = false;
  defrostOnStartDone = false;
  emergencyChangedAt = bootAtMs;
  compChangedAt = bootAtMs;
  lastDefrostAt = bootAtMs;
  lastDefrostHeatOffAt = bootAtMs;

  texto = "BOOT"; prepararTexto();

  // Display antes de WiFi para que el 7-seg no quede negro al arrancar.
  xTaskCreatePinnedToCore(
    displayTask,
    "disp",
    2048,
    NULL,
    2,
    &g_displayTaskHandle,
    1
  );

  setupWifi();
  if (!g_portalRunning) modoTexto = false;

  if (WiFi.status() == WL_CONNECTED && cloudCredentialsReady()) {
    g_pullNowRequested = true;
  }

  xTaskCreatePinnedToCore(
    networkTask,
    "net",
    8192,
    NULL,
    1,
    &g_netTaskHandle,
    0
  );
}

void loop() {
  esp_task_wdt_reset();
  leerSerial();
  handleButtonUi();

  // Refresco del display vive ahora en displayTask (core 1, prio 2).
  // El loop solo se ocupa de control, NTC, marquesinas y portal.

  if (millis() - lastReadAt >= 1000) {
    lastReadAt = millis();
    bool rawF1 = false, rawF2 = false;
    const float rawCam  = leerNTCpromedio(NTC1_PIN, rawF1, P.F03);
    const float rawEvap = leerNTCpromedio(NTC2_PIN, rawF2, P.F04);
    updateNtcFaultDebounced(rawF1, rawF2);
    pushTempRoll(!rawF1 ? rawCam : TEMP_ERR_VALUE, !rawF2 ? rawEvap : TEMP_ERR_VALUE);
    if (!fault1) tCam  = promedioMovilTemp(tCamRoll, tRollFill);
    else         tCam  = TEMP_ERR_VALUE;
    if (!fault2) tEvap = promedioMovilTemp(tEvapRoll, tRollFill);
    else         tEvap = TEMP_ERR_VALUE;
    if (g_ntcBootDiagPending && millis() - bootAtMs >= 4000UL) {
      g_ntcBootDiagPending = false;
      Serial.println(F("---- Diagnostico NTC al arranque (3 s) ----"));
      printNtcDiag();
    }
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
    aplicarDeratingPorCalor(millis());
  }

  serviceUiFlash(millis());

  if (g_uiMode == UI_PARAM_SELECT) {
    showParamCodeOnDisplay(g_paramMenu[g_paramCursor].code);
  } else if (g_uiMode == UI_PARAM_EDIT) {
    mostrarTemperatura(*g_paramMenu[g_paramCursor].value);
  } else if (!modoTexto && millis() - lastDisplaySwitchAt >= 1000) {
    lastDisplaySwitchAt = millis();
    refreshNormalDisplay();
  }

  // OJO: la telemetría, pull de AR y reintento de WiFi viven ahora en
  // networkTask() pinneada al core 0. El loop solo se ocupa del display,
  // sondas, control y portal.
}
