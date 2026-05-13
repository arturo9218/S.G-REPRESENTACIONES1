# PR500 — Esquema de placa (PCB) y mapa de GPIO — Firmware Stage3

**Referencia de firmware:** `firmware/esp32_pr500_supabase/esp32_pr500_stage3_app.ino`  
**MCU:** ESP32 (módulo tipo **ESP32-WROOM-32** o equivalente DevKit).  
**Nota:** El documento `PINOUT_MAESTRO_PCB_GENERICA_V1.md` es una **plantilla** de familia (PR500 / combistato). Los GPIO de **relés** y **presión** del Stage3 **no coinciden** con esa plantilla en todo (ej. relé 3 y sonda). Para producción PR500 usar **esta tabla** como verdad.

---

## 1. GPIO usados hoy en Stage3 (obligatorio en PCB)

| Función | GPIO | Dirección | Detalle |
|--------|------|-----------|---------|
| **ADC presión 4–20 mA** | **36** (`VP`, ADC1_CH0) | Entrada analógica | Shunt a GND (ej. **150 Ω**). Masa común con el lazo 4–20 mA. Atenuación ADC 11 dB en firmware. Rango útil ~0,6…3,0 V según transmisor. |
| **Relé compresor 1 (R1)** | **25** | Salida digital | Módulo relé **activo en BAJO** (LOW = ON). |
| **Relé compresor 2 (R2)** | **26** | Salida digital | Igual activo-bajo. |
| **Relé compresor 3 (R3)** | **32** | Salida digital | Igual activo-bajo. |
| **OneWire DS18B20** (succión, opcional) | **27** | Entrada digital + pull-up | **Alimentación 3,3 V** en la sonda / módulo. **Pull-up 4,7 kΩ entre DQ y 3,3 V**. No 5 V en pin ESP32. Parámetro **F29** habilita lectura. |
| **Forzar portal WiFi** | **14** | Entrada, `INPUT_PULLUP` | **A GND al arranque** abre portal de configuración (credenciales / URL ingest). En reposo dejar flotando o en alto. |

### Alimentación y masa

- **3,3 V** y **GND** del ESP32 para lógica, pull-ups y (si aplica) DS18B20 en 3,3 V.  
- El **lazo 4–20 mA** del transmisor de presión suele ir a **alimentación del transmisor** (12/24 V); el retorno pasa por el shunt hacia GND común con el ESP32 (diseño típico “single-ended”).

---

## 2. Display 7 segmentos y botones (no en Stage3 actual)

En **`esp32_pr500_stage3_app.ino` no hay** driver TM1637 ni lectura de teclado matricial: la parametrización y el monitoreo se hacen por **app web / Supabase** y **puerto serie** (`p`, `set`, etc.).

Si la **PCB** incluye **TM1637** y **botones** para una variante futura, conviene GPIO que **no choquen** con la tabla anterior. Referencia del combistato en repo (`esp32_combistato_1sonda_base.ino`):

| Periférico | GPIO sugerido (ej. combistato) | En PR500 Stage3 |
|------------|-------------------------------|------------------|
| TM1637 **CLK** | 18 | **Libre** — usable en variante con display. |
| TM1637 **DIO** | 19 | **Libre** — usable. |
| Botón UP | 13 | **Libre** (si se implementa firmware). |
| Botón DOWN | 14 | **Conflicto:** hoy **GPIO14 = portal**. En PCB con display, usar **otro pin** para portal (ej. 39 con pull-up) **o** otro pin para DOWN. |
| Botón SET | 16 | **Libre**. |
| ESC / manual | 17 | **Libre**. |

**Recomendación de diseño:** reservar en silksreen “TM1637 / botones — opción B” y un **jumper** o resistencia no montada para no activar portal en el mismo pin que un botón.

---

## 3. Salidas de relé (conector a placa de potencia)

| Señal PCB | GPIO | Comentario |
|-----------|------|------------|
| R1 / C1 | 25 | Salida a driver de relé (colector abierto / transistor / opto según módulo). |
| R2 / C2 | 26 | Idem. |
| R3 / C3 | 32 | Idem. |
| Común relés | — | Según módulo (VCC relé, GND, NO/NC). Respetar corriente de bobina y **diodo de rueda libre** en bobinas. |

**Lógica:** `LOW` = relé **energizado** (ON) con `RELAY_ACTIVE_HIGH = false` en firmware.

---

## 4. Entradas de sensores

| Sensor | Pin ESP32 | Tipo |
|--------|------------|------|
| Presión 4–20 mA | **36** | Analógica (shunt). |
| Temperatura succión DS18B20 | **27** | Digital 1-Wire. |

### Entradas digitales DI1…DI4 (nube / esquema SQL)

La tabla `pr500_readings` tiene columnas **`di1_ok` … `di4_ok`** (térmicos / presostato, etc.). **El Stage3 actual no las rellena desde GPIO** (quedan para expansión o otro binario). En PCB se pueden reservar, por ejemplo:

| Entrada | GPIO sugerido (reserva PCB) | Nota |
|---------|------------------------------|------|
| DI1 | 33 o 34 (solo entrada) | Entrada con pull y filtro RC. |
| DI2 | 34 o 35 | Solo ADC1 en algunos ESP32 — ver datasheet si se usa solo digital. |
| DI3 | 12 | Evitar strapping si se usa como entrada en arranque. |
| DI4 | 15 | Idem strapping. |

**Importante:** validar contra el **datasheet del módulo ESP32** concreto (strapping, ADC only pins).

---

## 5. Bus I2C y expansión (recomendación PCB)

Para **ADS1115** u otros ADC externos (mencionado en la plantilla genérica):

- **SDA → GPIO21**  
- **SCL → GPIO22**  

El Stage3 actual usa **ADC interno en GPIO36**, no ADS1115; el bus I2C puede quedar **conector sin poblar** o para sensor futuro.

---

## 6. Programación y servicio

| Función | Pin |
|---------|-----|
| UART0 TX | GPIO1 |
| UART0 RX | GPIO3 |
| Boot / flash | GPIO0 |
| EN | reset |

No usar GPIO0/1/3 para señales de campo.

---

## 7. Resumen visual rápido (Stage3)

```
                    ┌─────────────────┐
   4–20 mA + shunt ─┤ GPIO36  ADC     │
   DS18B20 DQ      ─┤ GPIO27  1-Wire  │  3V3 + 4k7 a DQ
   Portal config   ─┤ GPIO14  IN PU  │  GND al arranque = portal
   Relé C1         ─┤ GPIO25  OUT     │  activo BAJO
   Relé C2         ─┤ GPIO26  OUT     │
   Relé C3         ─┤ GPIO32  OUT     │
                    └─────────────────┘
```

---

## 8. Coherencia con `PINOUT_MAESTRO_PCB_GENERICA_V1.md`

| Ítem | Genérico v1 | Stage3 PR500 |
|------|----------------|--------------|
| Relé 3 | GPIO27 | **GPIO32** (GPIO27 = DS18B20) |
| Presión | ADS1115 / nota | **GPIO36** ADC interno |
| Portal / botón | GPIO14 compartido | **GPIO14 solo portal** en Stage3 |

Cualquier PCB “genérica” debe **revisarse** contra esta hoja para PR500.

---

*Documento generado para soporte de esquemático y cableado. Revisar siempre la última versión del `.ino` en el repositorio.*
