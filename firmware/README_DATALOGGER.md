# Datalogger ESP32 — AR Monitoreo

Firmware: `esp32_datalogger_supabase/esp32_datalogger.ino`

## Hardware de referencia (tu planta)

| Sensor | Modelo / tipo | Escalado |
|--------|---------------|----------|
| Corriente | **SCT-013** + módulo 0–1 V | **AR21–AR23** en la app (10/20/30/50/60 A por 1 V) |
| Presión | **4–20 mA** (igual PR500) | 150 Ω → **0,5…8 bar** (`PRESS_SCALE_MODE 0`) |

## Escala SCT desde la app (sin recompilar)

Cada canal de corriente tiene su propio parámetro:

| Canal | AR | Ejemplo pinza 10 A/1 V |
|-------|-----|------------------------|
| Consumo 1 | **AR21** | `10` |
| Consumo 2 | **AR22** | `20` |
| Consumo 3 | **AR23** | `30` |

1. En la app: **Dispositivos → Datalogger → AR21** (o AR22/AR23) → poné `10`, `20`, `30`, `50` o `60` según el jumper del módulo.
2. **Guardar en la nube**.
3. En el ESP32: `pull` (o esperar el próximo sync automático).

La app normaliza al valor más cercano (10, 20, 30, 50 o 60). El firmware aplica lo mismo al bajar parámetros.

Fórmula: **I (A) = voltaje_salida (V) × AR21/22/23**.

Solo si aún no hay sync de nube, el firmware usa `SCT_AMPS_PER_VOLT_FALLBACK` (default 30) al arrancar.

## Presión 4–20 mA (mismo que PR500)

Cableado idéntico al PR500 Stage3:

```
Transmisor (+) ----[150 Ω]---- GPIO ADC (AR10 / AR11)
Transmisor (-) ---- GND común ESP32
```

| Corriente | Tensión en ADC (150 Ω) | Presión |
|-----------|------------------------|---------|
| 4 mA | 0,60 V | **0,5 bar** |
| 20 mA | 3,00 V | **8 bar** |

`PRESS_SCALE_MODE 0` usa la misma fórmula que `esp32_pr500_stage3_app.ino`.

## Canales y nube

| Canal | AR | Campo nube |
|-------|-----|------------|
| Temp 1–6 | AR01–AR06 | `temp1_c` … `temp6_c` |
| Corriente 1–3 | AR07–AR09 | `current1_a` … |
| Potencia 1–3 | I × AR14 | `power1_w` … |
| Presión 1–2 | AR10–AR11 | `press1_bar`, `press2_bar` |
| Escala SCT | AR21–AR23 | solo config (no telemetría) |

## Comandos serie (115200)

| Comando | Acción |
|---------|--------|
| `raw` | mV ADC + valor convertido (calibrar SCT y presión) |
| `status` | Resumen + escalas activas por canal |
| `tx` | Enviar a nube |
| `pull` | Bajar AR desde app |
| `wifi` | Portal |

## Calibración rápida

1. **SCT:** configurá AR21–AR23 en la app → `pull` → sin carga `raw` → I ≈ 0 A; con carga conocida verificar A.
2. **Presión:** a 0,5 bar el ADC ≈ 600 mV; a 8 bar ≈ 3000 mV.

## Dependencias

WiFiManager, ArduinoJson v6, core ESP32
