# Integracion ESP8266 (Temperatura, Corriente, Presion)

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

- El firmware de ejemplo (`docs/esp8266_wifimanager_supabase.ino`) **ya envía** `current_a` con la lectura RMS del SCT (`readSctAmpsRms()`), luego un **filtro digital** (`filterSctAmpsForSend`: media exponencial + rechazo de picos fuera de un salto máximo) para suavizar ruido y errores puntuales.
- `power_w` en el ejemplo es `MAINS_V_RMS * amps` (informativo en gráficos); **el umbral de alarma por corriente en la nube usa solo `current_a`**.
- Si tu sketch no incluye SCT, podés omitir `current_a` o enviar `0`; no habrá alerta por corriente hasta que envíes un valor real.

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

1. ESP8266 lee sensores.
2. ESP envia HTTP POST cada 10-30s.
3. Function valida `moduleId` + `deviceToken`.
4. Inserta en `device_readings`.
5. Frontend consume lecturas y muestra historial/metricas.

## Portal WiFi (WiFiManager)

La **URL de ingest** va **fija en el firmware** (`DEFAULT_API_URL` en `esp8266_wifimanager_supabase.ino`); el portal solo permite editar WiFi, ID de módulo, clave API e intervalo.

El sketch define **`#define LANG_ES`** antes de incluir `WiFiManager.h` para usar los textos en español de la librería (menú, SSID, contraseña, etc.). Si al compilar no encontrá `wm_strings_es.h`, actualizá WiFiManager desde el Gestor de librerías o comentá `#define LANG_ES`.

El portal usa **CSS propio** (`setCustomHeadElement` y `setTitle`) para acercarlo al estilo del panel **AR Monitoreo** (fondo oscuro, acento azul). Si `setTitle` no existe en tu versión muy antigua de WiFiManager, comentá esa línea en `applyWiFiManagerTheme` y dejá solo `setCustomHeadElement`.

## Ficha del equipo (panel web)

En la app, pestaña **Ficha equipo** (`/ficha-equipo`), el técnico puede cargar **datos fijos del sistema frigorífico**, **bitácora** de visitas, **fotos** y **mantenimiento**; también **exportar PDF**. Solo aplica a dispositivos creados en la nube (ID de panel UUID). Requiere ejecutar en Supabase el SQL `supabase/sql/021_device_equipment_ficha.sql` (tablas + bucket Storage `equipment-photos`). Desde cada tarjeta de dispositivo en **Dispositivos** aparece el botón **Ficha** cuando el equipo es elegible.

## SQL y Function

- SQL: `supabase/sql/001_devices_and_readings.sql` (+ migraciones posteriores para umbrales, alarmas, calibración 020 y ficha 021)
- Function: `supabase/functions/ingest-reading/index.ts`

## Nota de seguridad

En produccion no comparar token en texto plano. Guardar hash (`bcrypt`/`argon2`) y validar contra ese hash.
