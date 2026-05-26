-- Comandos manuales del usuario al PRO300 desde la card del dashboard:
--   * Forzar compresor ON/OFF por 10 minutos (después vuelve al control auto).
--   * Forzar ventilador ON/OFF por 10 minutos.
--   * Disparar un ciclo de deshielo manual.
--   * Cancelar el ciclo de deshielo en curso (pasa al goteo y vuelve a auto).
--   * Cancelar cualquier forzado activo y volver al control automático.
--
-- La edge function `pro300-send-command` valida la sesión del usuario y
-- escribe el comando pendiente en `combistatos.pending_command`. Cuando el
-- ESP32 hace el siguiente POST de telemetría, ingest-reading le responde con
-- el `params_updated_at` actualizado y el ESP32 pulla los parámetros (donde
-- viaja también el comando). Esto da un delay click→ESP de ~30 s como mucho.
--
-- El ESP32 persiste en LittleFS el `ts` del último comando aplicado para no
-- reaplicarlo en cada pull. Server-side no hace falta limpiarlo: el comando
-- tiene `expiresAt` y el firmware lo ignora pasado ese punto.
--
-- Snapshot del estado de forzado vive en combistato_readings:
--   * comp_forced_remaining_s, fan_forced_remaining_s = segundos restantes
--     del override (0 si está en automático).
--
-- Ejecutar en Supabase SQL Editor después de 044.

alter table public.combistatos
  add column if not exists pending_command jsonb;

comment on column public.combistatos.pending_command is
  'Comando pendiente para el PRO300 escrito desde la app. Estructura:'
  ' { kind: ''force_comp''|''force_fan''|''force_defrost''|''cancel_defrost''|''cancel_force'','
  '   value: boolean | null, ts: iso8601, expiresAt: iso8601 }.'
  ' El firmware lo aplica y persiste el `ts` para no repetirlo.';

alter table public.combistato_readings
  add column if not exists comp_forced_remaining_s integer;

alter table public.combistato_readings
  add column if not exists fan_forced_remaining_s integer;

comment on column public.combistato_readings.comp_forced_remaining_s is
  'Segundos restantes del forzado manual del compresor (0 si está en automático).';

comment on column public.combistato_readings.fan_forced_remaining_s is
  'Segundos restantes del forzado manual del ventilador (0 si está en automático).';

notify pgrst, 'reload schema';
