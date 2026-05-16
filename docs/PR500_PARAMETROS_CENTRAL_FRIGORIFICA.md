# PR500 - Parametros para central frigorifica

Este controlador PR500 esta configurado para trabajar por presion de proceso en una central frigorifica con 1, 2 o 3 compresores.

## Logica de control (Stage3)

- `F22 = 0` (clasico): enciende etapa cuando la presion baja de banda y apaga cuando sube.
- `F22 = 1` (demanda alta P): enciende etapa cuando la presion sube y apaga al volver al set.

Para `F22 = 1`, por etapa `i` (`i=0` C1, `i=1` C2, `i=2` C3):

- ON si `P >= F02 + F03 - i*F04`
- OFF si `P <= F02 - i*F04`

## Descripcion rapida de parametros

### Parametros activos en firmware Stage3

- `F01`: armado general (`0` desarmado, `1` habilitado).
- `F02`: setpoint de presion (unidad definida por `F15`).
- `F03`: diferencial general de histeresis.
- `F04`: escalon entre etapas. Separa los umbrales de C1/C2/C3.
- `F05`: retardo minimo entre arranques.
- `F06`: tiempo minimo apagado por compresor.
- `F07`: tiempo minimo encendido por compresor.
- `F08`: cada **N horas** (entero), si **ningun** relé está ON, avanza el desfase `g_stageRot` (solo con `F28=0`). **`0`** = sin rotación de mapeo.
- `F09`: cantidad de **etapas de demanda por presión** (`1..3`). **No** limita qué bornes físicos R1/R2/R3 se usan (ver sección siguiente).
- `F28`: **`0`** = asignar etapas a relés con rotación (`F08`); **`1`** = balanceo por horómetro entre los primeros `F09` relés del pool (índices 0…F09−1).
- `F10`: umbral alarma **baja** presion (`0` = desactiva). Misma unidad que `F15`.
- `F11`: umbral alarma **alta** presion (`0` = desactiva).
- `F12`: segundos con `P < F10` para hacer latch de alarma baja.
- `F13`: segundos con `P > F11` para hacer latch de alarma alta.
- `F14`: offset de calibracion de presion.
- `F15`: unidad (`0=bar`, `1=psi`) para umbrales locales; **telemetria `pressure_bar` siempre en bar**.
- `F16`: pulso `1` desde la app: borra latch de alarmas (en pull cloud no se deja `F16=1` en flash).
- `F17`, `F18`, `F19`: forzado manual por compresor **fisico** C1–C3 (si `F01` esta armado).
- `F20`: marca de version logica (info, persistido).
- `F21`: reserva OTA (`0/1`, persistido; sin OTA en Stage3).
- `F22`: modo de histeresis (clasico o demanda alta P).

Con **alarma por presión** (F10/F11) activa (`r4_alarm` en ingesta): el firmware **apaga** los tres compresores. El latch queda hasta **reset**: `F16=1` desde la app (pull) o `set f16 1` por serie; luego el equipo guarda `F16=0` en flash.

Si la alarma es por **fallo de sensor** (F23≠0 y tensión ADC inválida), `r4_alarm` también va a **1**, pero los compresores entran en **ciclo ON/OFF** según F24/F25 (no quedan apagados fijos como con F10/F11).

### Fallo de sensor (cable cortado / desconectado) — F23…F27

En el ESP32 Stage3 la presión se lee por **ADC** (0…3,3 V). La señal se considera **inválida** si la tensión instantánea queda **fuera de la ventana `F26`…`F27`** (voltios en el pin). Por defecto **F26 = 0,08** y **F27 = 3,22** (transductor típico escalado a 0–3,3 V); podés ajustarlos desde la app si tu etapa de acondicionamiento usa otro rango.

- **`F23`**: segundos seguidos con señal inválida antes de hacer **latch** de alarma de sensor y entrar en modo emergencia. **`0`** desactiva esta detección (solo alarmas F10/F11 y control normal).
- **`F24`**: segundos en que los compresores **1…F09** quedan **encendidos juntos** en ese modo.
- **`F25`**: segundos **apagados** entre cada tramo de encendido (ciclo ON/OFF).
- **`F26` / `F27`**: umbral inferior y superior de tensión **válida** (el firmware exige al menos **0,05 V** de ventana entre ambos).

Mientras dura la alarma de sensor, `r4_alarm` en la nube va en **1** (igual que alarma baja/alta). Tras **F16** o cuando la tensión vuelve a ser válida el mismo tiempo que indica **F23**, se borra el latch y se sale del ciclo de emergencia.

### Horas de marcha (telemetría)

El firmware Stage3 envía en cada POST a `ingest-reading` los campos opcionales **`comp1_run_ms`**, **`comp2_run_ms`**, **`comp3_run_ms`**: milisegundos ON acumulados por relé (mismo contador que en `/comp_runtime.json` en el ESP32). La tabla `pr500_readings` debe tener esas columnas: ejecutá **`038_pr500_readings_comp_run_ms.sql`** en Supabase y redeployá **`ingest-reading`**. La app muestra horas en la tarjeta del panel y en el gráfico histórico (última muestra del rango).

### App web: ver presion en psi

Si en `pr500_controllers.params` el control tiene **`F15 = 1`**, el panel y el grafico convierten `pressure_bar` (bar) a **psi** para mostrar. La base de datos no cambia: sigue en bar.

## F09, F08 y F28: etapas lógicas, relés físicos y rotación

Esta sección aclara malentendidos frecuentes (p. ej. “con `F09=2` solo deben prender R1 y R2” o “la rotación apaga R1 al prender R2”). Firmware de referencia: `firmware/esp32_pr500_supabase/esp32_pr500_stage3_app.ino`.

### Tres ideas distintas (no mezclar)

| Concepto | Parámetro | Qué hace en Stage3 |
|----------|-----------|-------------------|
| **Cuántas etapas de presión** pueden pedir marcha **a la vez** | **`F09`** (`1..3`) | Si la presión lo exige, pueden estar ON la etapa lógica 0, la 1 y/o la 2 **en paralelo** (hasta `F09` etapas). |
| **Qué relé físico** (R1, R2, R3) corresponde a cada etapa lógica | **`F28`** + **`F08`** | Con `F28=0`, el mapeo rota entre los **tres** bornes. Con `F28=1`, solo se usan relés **0…F09−1** (p. ej. R1 y R2 si `F09=2`). |
| **Tiempos mínimos** entre arranques y ON/OFF | **`F05`**, **`F06`**, **`F07`** | Anti-ciclado; **no** implementan “al prender R2 apagar R1”. |

En la app y en la nube, **C1 / C2 / C3** son los **tres relés físicos** (`r1_on`, `r2_on`, `r3_on`), no “tres máquinas obligatorias”. Si en planta solo hay **dos compresores**, cableados en R1 y R2, conviene configurar parámetros para que el firmware **no energice R3** en automático (ver abajo).

### Qué **no** hace `F09 = 2`

- **No** significa “solo usar bornes R1 y R2”.
- **No** significa “un solo compresor a la vez”.
- Significa: la lógica de presión puede activar hasta **dos etapas lógicas** (0 y 1) **simultáneamente** si los umbrales (F02, F03, F04, F22) lo piden.

La etapa lógica 2 queda **siempre desactivada** en histéresis cuando `F09=2` (no hay “tercera etapa de demanda”).

### Qué **no** hace la rotación (`F08` con `F28 = 0`)

Malentendido habitual: “si R1 prendió primero y después prende R2, debería apagar R1”.

En Stage3 la rotación **no** es lead/lag alternado. Es:

1. **`F08`**: cada **N horas** (valor entero de `F08`), solo si **ningún** relé está ON, se incrementa `g_stageRot` (0 → 1 → 2 → 0).
2. **`F28 = 0`**: cada etapa lógica que pide marcha se asigna a un relé físico con  
   **`relé_físico = (etapa_lógica + g_stageRot) % 3`**.

Si las **dos** etapas lógicas piden ON a la vez, pueden quedar **dos relés ON en paralelo** (no se apaga el primero al encender el segundo).

#### Tabla de mapeo (`F28 = 0`, `F09 ≥ 2`, ambas etapas 0 y 1 pedidas)

| `g_stageRot` | Etapa 0 → relé | Etapa 1 → relé | Relés ON (típico) |
|--------------|----------------|----------------|-------------------|
| 0 | R1 (C1) | R2 (C2) | R1 + R2 |
| 1 | R2 (C2) | R3 (C3) | R2 + **R3** |
| 2 | R3 (C3) | R1 (C1) | **R3** + R1 |

Por eso, con **dos compresores reales** en R1 y R2 pero **`F28=0`** y **`F08>0`**, es **normal** ver en telemetría **`comp3_on = true`**: una etapa está accionando el **tercer relé**, aunque no exista “máquina 3”.

### Modo balanceo (`F28 = 1`)

Con **`F28 = 1`**, el pool de relés es solo **`0 … F09−1`**:

- **`F09 = 2`** → pool **R1 y R2** únicamente; **R3 no se enciende** en automático por balanceo.
- Se eligen los relés con **menor** tiempo ON acumulado (`comp*_run_ms` / horómetro en flash) para repartir desgaste **entre esos dos bornes**.

Recomendado para centrales con **solo dos compresores** cableados en C1 y C2.

### Ajustes recomendados según instalación

| Instalación | Sugerencia |
|-------------|------------|
| **2 compresores en R1 y R2**, sin uso de R3 | **`F09 = 2`**, **`F28 = 1`**, **`F08 = 0`** (o `F08` alto si no querés cambiar mapeo horario). **`F17`/`F18`/`F19 = 0`**. |
| **3 compresores**, reparto por horas de marcha | **`F09 = 3`**, **`F28 = 1`** (balanceo) o **`F28 = 0`** + **`F08`** según estrategia de rotación de lead. |
| **Solo un compresor** en servicio automático | **`F09 = 1`**. |
| Relé R3 sin motor (reserva) | Igual que 2 compresores: **`F28 = 1`** y **`F09 = 2`**; dejar R3 sin carga. |

### Telemetría y “volvió en línea con C3 ON”

Tras corte de WiFi o reinicio del ESP:

- La app muestra el último `comp1_on` / `comp2_on` / `comp3_on` recibido; puede coincidir con un tramo en que **`g_stageRot`** era 1 o 2.
- Un reinicio **no** borra parámetros en flash (`/pr500_params.json`); ver persistencia en firmware.
- Si tras el evento **sigue** apareciendo C3 con **`F09=2`** y **`F28=1`**, revisar manual **`F19`**, alarma de sensor (**F23**…**F25** enciende solo los primeros `F09` relés en emergencia, no R3 si `F09=2`), o pull de parámetros desde la nube con valores distintos.

### Referencia rápida en monitor serie

Tras el arranque, líneas `[PRM]` incluyen `F09`, `F22`, `rot=` (`g_stageRot`). Con `F22=1` se imprimen umbrales ON/OFF por etapa. Comando útil: `p` o `status`.

## Recomendacion de ajuste inicial (psi)

- `F15=1`, `F22=1`, `F09=3`
- `F02=18`, `F03=3.5`, `F04=0.5`
- `F05=30`, `F06=120`, `F07=180`

Con esos valores:

- C1 ON >= 21.5 / OFF <= 18.0
- C2 ON >= 21.0 / OFF <= 17.5
- C3 ON >= 20.5 / OFF <= 17.0

Si baja demasiado la presion minima, reducir `F04` o subir `F02`.

## Precision y validacion en planta (check rapido)

Objetivo: confirmar que la logica real coincide con los parametros cargados y que no hay ciclado excesivo.

### 1) Precondiciones

- Sensor de presion calibrado y estable.
- `F01=1` (armado), `F15` en la unidad correcta, `F22` segun estrategia.
- Si se prueba automatico, dejar `F17/F18/F19 = 0`.

### 2) Verificacion de umbrales (F02/F03/F04/F22)

Con `F22=1`, comparar en tendencia o serial:

- C1 ON en `F02+F03`, OFF en `F02`
- C2 ON en `F02+F03-F04`, OFF en `F02-F04`
- C3 ON en `F02+F03-2*F04`, OFF en `F02-2*F04`

Tolerancia recomendada por lectura/ruido: +/-0.2 psi (o equivalente en bar).

### 3) Verificacion anti-ciclado (F05/F06/F07)

- `F05`: entre dos arranques consecutivos de cualquier compresor debe pasar al menos `F05` segundos.
- `F06`: un compresor apagado no puede reencender antes de `F06` segundos.
- `F07`: un compresor encendido no puede apagarse antes de `F07` segundos.

Referencia en firmware Stage3:

- `gap = F05`, `minOff = F06`, `minOn = F07` en `applyRelays()`.
- Nota: el modo manual (`F17/F18/F19`) fuerza encendido inmediato y puede puentear esperas de arranque.

### 4) Criterio de aceptacion

- Umbrales de ON/OFF coinciden con formulas.
- Sin arranques en rafaga ni on/off rapido.
- Presion minima dentro del piso esperado por `F02` y `F04`.

Si la minima cae de mas: bajar `F04` o subir `F02`.
Si hay ciclado: subir `F03` y/o `F07`; revisar `F06`.

### 5) Dos compresores (solo R1 y R2)

- Confirmar **`F09=2`**, **`F28=1`**, **`F08=0`** (salvo que se quiera otra política documentada arriba).
- Con demanda alta, verificar en serial o panel que **no** queda `comp3_on` en régimen normal.
- Si con **`F28=0`** y **`F08>0`** aparece C3 ON con dos etapas activas, es comportamiento esperado del mapeo `(etapa + rot) % 3`, no fallo de `F09`.
