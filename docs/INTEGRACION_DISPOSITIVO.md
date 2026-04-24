# Integración del dispositivo (temperatura, corriente, presión)

## Cabeceras HTTP (Supabase)

Las Edge Functions se publican en `https://<ref>.supabase.co/functions/v1/<nombre>`. El **gateway** de Supabase espera la clave pública del proyecto en las cabeceras (igual que el cliente JS del frontend):

- `apikey: <anon public>`
- `Authorization: Bearer <anon public>`
- `Content-Type: application/json`

La clave **anon** está en **Project Settings → API → Project API keys → anon public**.  
El campo JSON `deviceToken` es **otra cosa**: es el token del dispositivo guardado en la fila de `devices`, no sustituye a la anon.

El sketch de ejemplo para **ESP8266** (`docs/esp8266_wifimanager_supabase.ino`) y el firmware **ESP32 combistato** (`docs/esp32_combistato_supabase.ino`) envían esas cabeceras si definís `DEFAULT_SUPABASE_ANON_KEY` en el firmware o si agregás `supabaseAnonKey` en `/config.json` (LittleFS). Si ves `401` en el Serial (`[HTTP] code=401`), revisá esto antes que `moduleId` / `deviceToken`.

## Payload recomendado

Enviar `POST` a la Function `ingest-reading` con JSON:

```json
{
  "moduleId": "equipo-frio-01",
  "deviceToken": "token-del-dispositivo",
  "sentAt": "2026-03-24T12:45:00Z",
  "temp1_c": -3.2,
  "temp2_c": -2.9,
  "temp3_c": null,
  "current_a": 0.85,
  "power_w": 187.0,
  "press1_bar": 2.31,
  "press2_bar": 2.28
}
```

### Corriente (`current_a`)

- El sketch **ESP8266** (`docs/esp8266_wifimanager_supabase.ino`) **envía** `current_a` con la lectura RMS del SCT (`readSctAmpsRms()`), más el filtro `filterSctAmpsForSend`. El firmware **ESP32 combistato** (`docs/esp32_combistato_supabase.ino`) no usa pinza: envía `current_a: 0` y `power_w: 0`, y manda temperaturas desde **NTC 10k** en ADC. Parámetros en LittleFS `/combistato.json`; por **Serial** (115200): `help`, modo técnico `tech on|off`, manuales `mcomp`/`mfan`/`mdef`, prueba de relés `rcomp`/`rfan`/`rdef` (ver cabecera del `.ino`).
- `power_w` en el ejemplo es `MAINS_V_RMS * amps` (informativo en gráficos); **el umbral de alarma por corriente en la nube usa solo `current_a`**.
- Si tu programa no incluye SCT, podés omitir `current_a` o enviar `0`; no habrá alerta por corriente hasta que envíes un valor real.

## Mapeo de sensores

- `temp1_c`: temperatura principal (grafico y alertas)
- `temp2_c`, `temp3_c`: temperaturas adicionales
- `current_a`: **corriente RMS (A)** — requerida para alertas por amperaje
- `power_w`: potencia (W), opcional
- `press1_bar`, `press2_bar`: presiones

## Formas de “notificación”

1. **Web Push** (app cerrada): requiere secrets VAPID en Supabase y activar avisos en el navegador/PWA.
2. **Panel web** (app abierta): “Alertas activas” y pitido usan las mismas lecturas; no dependen del push.
3. **Historial en la nube**: filas en `device_alarm_events` cuando la función registra un disparo (aunque el push falle).

La respuesta JSON de `ingest-reading` puede incluir `push: { sent, skipped, ... }` y, si hubo error al leer umbrales, `thresholdsWarning` (revisar migraciones SQL).

## Flujo

1. El equipo lee sensores.
2. Envía HTTP POST cada 10-30s.
3. Function valida `moduleId` + `deviceToken`.
4. Inserta en `device_readings`.
5. Frontend consume lecturas y muestra historial/metricas.

## Portal WiFi (configuración)

La **URL de ingest** suele ir **fija en el programa** (`DEFAULT_API_URL` en los `.ino` de `docs/`); el portal solo permite editar WiFi, ID de módulo, clave API e intervalo.

Los sketches definen **`#define LANG_ES`** antes de incluir `WiFiManager.h` para usar los textos en español de la librería (menú, SSID, contraseña, etc.). Si al compilar no encontrá `wm_strings_es.h`, actualizá WiFiManager desde el Gestor de librerías o comentá `#define LANG_ES`.

El portal usa **CSS propio** (`setCustomHeadElement` y `setTitle`) para acercarlo al estilo del panel **AR Monitoreo** (fondo oscuro, acento azul). Si `setTitle` no existe en tu versión muy antigua de WiFiManager, comentá esa línea en `applyWiFiManagerTheme` y dejá solo `setCustomHeadElement`.

## Ficha del equipo (panel web)

En la app, pestaña **Ficha equipo** (`/ficha-equipo`), el técnico puede cargar **datos fijos del sistema frigorífico** (incluido condensador y evaporador con detalle), **bitácora** de visitas, **fotos** y **mantenimiento**; también **exportar PDF**. Se pueden **varias fichas por dispositivo** (por ejemplo dos cámaras en un mismo equipo), cada una con nombre, bitácora y fotos propias.

Solo aplica a dispositivos creados en la nube (ID de panel UUID). Requiere ejecutar en Supabase:

- `supabase/sql/021_device_equipment_ficha.sql` — tablas base, bucket Storage `equipment-photos`.
- `supabase/sql/022_device_equipment_fichas.sql` — varias fichas por dispositivo, columnas de condensador/evaporador ampliadas y vínculos de bitácora/fotos por ficha.
- `supabase/sql/023_device_expansion_capillary_valve.sql` — tipo de expansión (capilar / válvula) en la ficha.
- `supabase/sql/024_get_device_readings_chart_raw.sql` — el gráfico de análisis recibe valores en crudo y aplica la corrección de consumo/temperatura como en el panel (ejecutar para que el offset afecte la curva).

Desde cada tarjeta de dispositivo en **Dispositivos** aparece el botón **Ficha** cuando el equipo es elegible.

## Combistato (ESP32) en el panel

- SQL: `supabase/sql/033_combistatos.sql` — tabla **`combistatos`**: cada fila es un registro propio (`owner_user_id`, `name`, `location`, `module_id`, `device_token_hash`, `params` JSONB F01–F55). **No** está ligada a `devices`: podés tener muchos combistatos y muchos dispositivos por separado.
- Conexión: el combistato usa el **mismo esquema que dispositivos** en el portal del equipo: `api_url` + `module_id` + `api_key` (token de 6 dígitos).
- En **Dispositivos** (misma vista que las tarjetas de temperatura): sección **Combistatos** — alta con **+ Combistato**, tarjetas, edición de nombre/ubicación/`module_id`, modal con credenciales para portal y formulario **Combistato (ESP32)** al seleccionar una tarjeta. **Copiar JSON** para `/combistato.json` del firmware (`docs/esp32_combistato_supabase.ino`). El ESP32 aún no descarga solo desde la nube; el JSON sirve para LittleFS / herramientas de subida.
- Obsoleto / opcional: `supabase/sql/032_device_combistato.sql` (`device_combistato` por `device_id`) — la app ya no usa esa tabla para el panel; podés ignorarla o migrar datos a mano si tenías filas.

## SQL y Function

- SQL: `supabase/sql/001_devices_and_readings.sql` (+ migraciones posteriores para umbrales, alarmas, calibración 020 y ficha 021, fichas múltiples 022; combistato independiente **033**; 032 solo si mantenés datos legacy)
- Function: `supabase/functions/ingest-reading/index.ts`

## Nota de seguridad

En produccion no comparar token en texto plano. Guardar hash (`bcrypt`/`argon2`) y validar contra ese hash.
