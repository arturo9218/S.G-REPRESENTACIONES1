/**
 * ESP32 Combistato 1 sonda - Base v1 (PCB generica)
 *
 * Hardware objetivo:
 * - ESP32-WROOM-32
 * - ADS1115 por I2C (SDA=21, SCL=22) para sonda S1
 * - Display TM1637 (CLK=18, DIO=19)
 * - Botones: UP=13, DOWN=14, SET=16, ESC/MANUAL=17
 * - Reles: R1=25, R2=26, R3=27
 *
 * Esta base es intencionalmente simple para escalar producto:
 * - Control termostatico 1 sonda con histersis
 * - Minimo tiempo ON/OFF de compresor
 * - Modo manual rapido por boton ESC
 *
 * Dependencias (Arduino Library Manager):
 * - Adafruit ADS1X15
 * - TM1637Display
 */

#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <TM1637Display.h>

// ===== Pinout PCB generica =====
static const int PIN_I2C_SDA = 21;
static const int PIN_I2C_SCL = 22;

static const int PIN_TM1637_CLK = 18;
static const int PIN_TM1637_DIO = 19;

static const int PIN_BTN_UP = 13;
static const int PIN_BTN_DOWN = 14;
static const int PIN_BTN_SET = 16;
static const int PIN_BTN_ESC = 17;

static const int PIN_R1 = 25;  // Compresor principal
static const int PIN_R2 = 26;  // Ventilador / salida auxiliar
static const int PIN_R3 = 27;  // Deshielo / salida auxiliar

// ===== Control 1 sonda =====
struct Params1Sonda {
  float sp_c = -18.0f;          // Setpoint
  float diff_c = 3.0f;          // Histeresis total
  float corr_s1_c = 0.0f;       // Correccion de lectura
  uint16_t min_off_s = 60;      // Minimo apagado compresor
  uint16_t min_on_s = 30;       // Minimo encendido compresor
  uint8_t relay_active_high = 1;
} P;

Adafruit_ADS1115 ads_1;  // 0x48
TM1637Display display(PIN_TM1637_CLK, PIN_TM1637_DIO);

static bool g_comp_on = false;
static bool g_manual_mode = false;
static unsigned long g_last_comp_switch_ms = 0;
static unsigned long g_last_ui_ms = 0;
static unsigned long g_last_ctrl_ms = 0;

// Debounce por flanco para respuesta rapida y estable
static bool g_btn_prev[4] = {false, false, false, false};
static unsigned long g_btn_last_edge_ms[4] = {0, 0, 0, 0};
static constexpr unsigned long BTN_DEBOUNCE_MS = 35;

// NTC 10k beta 3950 (ajustable a tu sonda real)
static constexpr float NTC_SERIES_OHM = 10000.0f;
static constexpr float NTC_R0_OHM = 10000.0f;
static constexpr float NTC_BETA = 3950.0f;
static constexpr float NTC_T0_K = 298.15f;  // 25C
static constexpr float ADS_FS_V = 4.096f;   // GAIN_ONE
static constexpr float ADS_COUNTS = 32767.0f;

static inline bool btnPressed(int pin) { return digitalRead(pin) == LOW; }

static bool consumePressEdge(int pin, int idx, unsigned long nowMs) {
  const bool cur = btnPressed(pin);
  const bool prev = g_btn_prev[idx];
  g_btn_prev[idx] = cur;
  if (!cur || prev) return false;  // solo flanco LOW (no repeticion por mantener)
  if (nowMs - g_btn_last_edge_ms[idx] < BTN_DEBOUNCE_MS) return false;
  g_btn_last_edge_ms[idx] = nowMs;
  return true;
}

static inline void relayWrite(int pin, bool on) {
  const int onLevel = (P.relay_active_high != 0) ? HIGH : LOW;
  const int offLevel = (onLevel == HIGH) ? LOW : HIGH;
  digitalWrite(pin, on ? onLevel : offLevel);
}

static void allRelaysOff() {
  relayWrite(PIN_R1, false);
  relayWrite(PIN_R2, false);
  relayWrite(PIN_R3, false);
}

static float ntcVoltageToCelsius(float v) {
  if (v <= 0.01f || v >= (ADS_FS_V - 0.01f)) return NAN;
  const float rntc = NTC_SERIES_OHM * v / (ADS_FS_V - v);
  if (rntc <= 1.0f || rntc > 1.0e7f) return NAN;
  const float steinh = logf(rntc / NTC_R0_OHM) / NTC_BETA + 1.0f / NTC_T0_K;
  return 1.0f / steinh - 273.15f;
}

static float readS1Celsius() {
  // Canal A0 del ADS1115 #1
  const int16_t raw = ads_1.readADC_SingleEnded(0);
  const float v = ((float)raw / ADS_COUNTS) * ADS_FS_V;
  const float tc = ntcVoltageToCelsius(v);
  if (isnan(tc)) return NAN;
  return tc + P.corr_s1_c;
}

static void updateThermostat(float tc, unsigned long nowMs) {
  if (isnan(tc)) {
    // Si falla lectura, seguridad: compresor OFF
    if (g_comp_on && (nowMs - g_last_comp_switch_ms >= (unsigned long)P.min_on_s * 1000UL)) {
      g_comp_on = false;
      g_last_comp_switch_ms = nowMs;
      relayWrite(PIN_R1, false);
    }
    return;
  }

  // Frio clasico:
  // - Si esta ON, corta al llegar a setpoint
  // - Si esta OFF, enciende por arriba de SP + diff
  const float onTh = P.sp_c + P.diff_c;
  const float offTh = P.sp_c;

  if (!g_comp_on) {
    const bool canStart = (nowMs - g_last_comp_switch_ms >= (unsigned long)P.min_off_s * 1000UL);
    if (canStart && tc >= onTh) {
      g_comp_on = true;
      g_last_comp_switch_ms = nowMs;
      relayWrite(PIN_R1, true);
    }
  } else {
    const bool canStop = (nowMs - g_last_comp_switch_ms >= (unsigned long)P.min_on_s * 1000UL);
    if (canStop && tc <= offTh) {
      g_comp_on = false;
      g_last_comp_switch_ms = nowMs;
      relayWrite(PIN_R1, false);
    }
  }
}

static void handleButtons(unsigned long nowMs) {
  bool changed = false;
  if (consumePressEdge(PIN_BTN_UP, 0, nowMs)) {
    P.sp_c += 0.5f;
    changed = true;
  } else if (consumePressEdge(PIN_BTN_DOWN, 1, nowMs)) {
    P.sp_c -= 0.5f;
    changed = true;
  } else if (consumePressEdge(PIN_BTN_ESC, 3, nowMs)) {
    // Modo manual rapido: fuerza R1 ON/OFF
    g_manual_mode = !g_manual_mode;
    if (!g_manual_mode) {
      // Al salir de manual, vuelve a OFF y retoma automatismo
      g_comp_on = false;
      relayWrite(PIN_R1, false);
      g_last_comp_switch_ms = nowMs;
    }
    changed = true;
  }

  // Boton SET: en manual conmuta compresor 1 instantaneo; en auto ajusta diferencial
  if (consumePressEdge(PIN_BTN_SET, 2, nowMs)) {
    if (g_manual_mode) {
      g_comp_on = !g_comp_on;
      relayWrite(PIN_R1, g_comp_on);  // respuesta inmediata
      g_last_comp_switch_ms = nowMs;
      Serial.printf("[MAN] R1 -> %s\n", g_comp_on ? "ON" : "OFF");
    } else {
      P.diff_c += 0.5f;
      if (P.diff_c > 8.0f) P.diff_c = 1.0f;
      changed = true;
    }
  }

  if (changed) {
    if (P.diff_c < 0.5f) P.diff_c = 0.5f;
    if (P.diff_c > 12.0f) P.diff_c = 12.0f;
  }
}

static void handleSerialFast(unsigned long nowMs) {
  if (!Serial.available()) return;
  String s = Serial.readStringUntil('\n');
  s.trim();
  s.toLowerCase();
  if (s == "r1 on" || s == "r1 1") {
    g_manual_mode = true;
    g_comp_on = true;
    relayWrite(PIN_R1, true);
    g_last_comp_switch_ms = nowMs;
    Serial.println(F("[SER] R1 ON (manual)"));
  } else if (s == "r1 off" || s == "r1 0") {
    g_manual_mode = true;
    g_comp_on = false;
    relayWrite(PIN_R1, false);
    g_last_comp_switch_ms = nowMs;
    Serial.println(F("[SER] R1 OFF (manual)"));
  } else if (s == "auto") {
    g_manual_mode = false;
    Serial.println(F("[SER] AUTO"));
  } else if (s == "p") {
    Serial.printf("[PRM] sp=%.2f diff=%.2f minOff=%u minOn=%u manual=%d comp=%d\n",
                  P.sp_c, P.diff_c, P.min_off_s, P.min_on_s, (int)g_manual_mode, (int)g_comp_on);
  }
}

static void showOnDisplay(float tc) {
  // Alterna cada ~2 s entre temperatura medida y setpoint
  const unsigned long nowMs = millis();
  const bool showMeasured = ((nowMs / 2000UL) % 2UL) == 0UL;
  int valueToShow = 0;

  if (showMeasured) {
    if (isnan(tc)) {
      display.showNumberDecEx(0, 0b01000000, true);  // muestra 0 con punto central
      return;
    }
    valueToShow = (int)lroundf(tc * 10.0f);  // 1 decimal
  } else {
    valueToShow = (int)lroundf(P.sp_c * 10.0f);
  }

  // Muestra con un decimal: 12.3 -> 123 y punto entre digitos centrales
  display.showNumberDecEx(valueToShow, 0b01000000, false);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n[BOOT] Combistato 1 sonda base v1"));

  pinMode(PIN_BTN_UP, INPUT_PULLUP);
  pinMode(PIN_BTN_DOWN, INPUT_PULLUP);
  pinMode(PIN_BTN_SET, INPUT_PULLUP);
  pinMode(PIN_BTN_ESC, INPUT_PULLUP);

  pinMode(PIN_R1, OUTPUT);
  pinMode(PIN_R2, OUTPUT);
  pinMode(PIN_R3, OUTPUT);
  allRelaysOff();

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  ads_1.setGain(GAIN_ONE);  // +/-4.096V
  if (!ads_1.begin(0x48)) {
    Serial.println(F("[ADC] No se detecta ADS1115 en 0x48"));
  } else {
    Serial.println(F("[ADC] ADS1115 listo en 0x48"));
  }

  display.setBrightness(0x0f, true);
  display.showNumberDec(1001, false);  // marcador de arranque
  delay(600);
}

void loop() {
  const unsigned long nowMs = millis();
  handleSerialFast(nowMs);
  handleButtons(nowMs);
  const float tc = readS1Celsius();

  // Tick de control rapido (20 ms) para respuesta consistente
  if (!g_manual_mode && (nowMs - g_last_ctrl_ms >= 20)) {
    g_last_ctrl_ms = nowMs;
    updateThermostat(tc, nowMs);
  }

  // R2/R3 quedan libres para futuras funciones
  relayWrite(PIN_R2, false);
  relayWrite(PIN_R3, false);

  if (nowMs - g_last_ui_ms >= 200) {
    g_last_ui_ms = nowMs;
    showOnDisplay(tc);
  }

  static unsigned long lastLogMs = 0;
  if (nowMs - lastLogMs >= 2000) {
    lastLogMs = nowMs;
    Serial.printf("[RUN] tc=%.2fC sp=%.2f diff=%.2f comp=%d manual=%d\n",
                  tc, P.sp_c, P.diff_c, (int)g_comp_on, (int)g_manual_mode);
  }
}

