# PRO400 — plaqueta PRO300, 1 sonda, 1 relé compresor

## Firmware correcto para tu placa

Si la placa es **la misma que PRO300** (CD4094 + 7 seg + botonera):

→ **`esp32_pro400_cd4094/esp32_pro400_cd4094.ino`** con módulo **ESP32**.

## Pines (igual PRO300)

| Señal | GPIO ESP32 |
|--------|------------|
| NTC sonda 1 | **34** |
| CD4094 DATA | **23** |
| CD4094 CLOCK | **18** |
| CD4094 STROBE | **5** |
| Relé compresor | Salida **bit 5** del 2.º 4094 (único relé) |
| UP | **13** |
| DOWN | **14** |
| SET | **27** |
| BACK / VOLVER | **17** |
| Portal forzado | **GPIO0** a GND al encender |

## Botones (mismas combinaciones que PRO300)

| Acción | Cómo |
|--------|------|
| Menú parámetros **A01…** | **UP + DOWN** ~1,2 s |
| Portal WiFi **PRO400-Setup** | **SET + ABAJO** ~0,8 s (también SET+UP o SET+VOLVER) |
| Portal WiFi | **SET** solo ~**4 s** |
| Menú por SET | **SET** ~1,2 s (soltá antes de 4 s) |
| Deshielo manual | **UP** solo ~1,2 s |
| Cancelar deshielo | **UP** toque durante deshielo/goteo |
| Cambiar vista display | **DOWN** toque (temp → fase → minutos) |
| Volver a temperatura | **VOLVER** toque (1 sonda; en PRO300 mostraba sonda 2) |

Consigna **AR01** se cambia solo desde la **app** o menú **A01**, no con toques cortos UP/DOWN.

## Parámetros

- Equipo: **F01–F26** + **F50** (inversión relé).
- App: **AR01–AR26** + **AR50**.
- Display: **A01…A26**, **A50**.

## ESP8266

Solo si el módulo **no** es el zócalo ESP32 de la plaqueta PRO300: ver `esp8266_pro400/` (otros GPIO).

## Nube

- `fetch-pro400-params` — pull parámetros  
- `ingest-reading` — telemetría  
- SQL **047** y **048**
