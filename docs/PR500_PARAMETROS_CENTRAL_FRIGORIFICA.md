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
- `F08`: rotacion de “lead” cada N horas (`0` = sin rotacion). Solo avanza con **ningun** compresor en marcha.
- `F09`: cantidad de compresores en demanda (`1..3`).
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

### App web: ver presion en psi

Si en `pr500_controllers.params` el control tiene **`F15 = 1`**, el panel y el grafico convierten `pressure_bar` (bar) a **psi** para mostrar. La base de datos no cambia: sigue en bar.

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
