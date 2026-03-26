# Integracion ESP8266 (Temperatura, Consumo, Presion)

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
  "power_w": 185.4,
  "press1_bar": 2.31,
  "press2_bar": 2.28
}
```

## Mapeo de sensores

- `temp1_c`: temperatura principal (grafico y alertas actuales)
- `temp2_c`, `temp3_c`: temperaturas adicionales
- `power_w`: consumo
- `press1_bar`, `press2_bar`: presiones

## Flujo

1. ESP8266 lee sensores.
2. ESP envia HTTP POST cada 10-30s.
3. Function valida `moduleId` + `deviceToken`.
4. Inserta en `device_readings`.
5. Frontend consume lecturas y muestra historial/metricas.

## SQL y Function

- SQL: `supabase/sql/001_devices_and_readings.sql`
- Function: `supabase/functions/ingest-reading/index.ts`

## Nota de seguridad

En produccion no comparar token en texto plano. Guardar hash (`bcrypt`/`argon2`) y validar contra ese hash.
