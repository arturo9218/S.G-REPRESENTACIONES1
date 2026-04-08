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

- El firmware de ejemplo (`docs/esp8266_wifimanager_supabase.ino`) **ya envía** `current_a` con la lectura RMS del SCT (`readSctAmpsRms()` → campo JSON `current_a`).
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

## SQL y Function

- SQL: `supabase/sql/001_devices_and_readings.sql` (+ migraciones posteriores para umbrales y alarmas)
- Function: `supabase/functions/ingest-reading/index.ts`

## Nota de seguridad

En produccion no comparar token en texto plano. Guardar hash (`bcrypt`/`argon2`) y validar contra ese hash.
