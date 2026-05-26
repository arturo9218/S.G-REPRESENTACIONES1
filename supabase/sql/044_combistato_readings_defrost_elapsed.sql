-- Snapshot de la "fase" actual del controlador PRO300 + cronómetro.
-- El firmware reporta en cada telemetría qué bloque está corriendo:
--   'boot'         → retardo al encender (AR14 / F38)
--   'normal'       → control termostático estándar (no time-boxed)
--   'defrost'      → ciclo de deshielo (AR11 / F07 minutos máx, AR12/F08 corte S2)
--   'drip'         → goteo post-deshielo (AR15 / F39 minutos)
--   'post_defrost' → ventilador en espera tras goteo (AR21 / F11 minutos)
--   'emerg'        → ciclo de emergencia por sonda fallada (AR32-AR34 / F19-F20)
--   'off'          → todo apagado (sonda fallada con F55=0, o comando manual)
--
-- `phase_elapsed_s` = segundos transcurridos dentro de la fase actual.
-- `phase_total_s`   = duración total prevista para fases cronometradas (0 si no aplica).
--
-- Permite que la card del PRO300 muestre "Transcurrido / Faltan" para cualquier
-- bloque (no solo deshielo). Para `defrost` la temp de corte sale de params.
--
-- Ejecutar en Supabase SQL Editor después de 043_device_readings_relays.sql.

alter table public.combistato_readings
  add column if not exists phase text;

alter table public.combistato_readings
  add column if not exists phase_elapsed_s integer;

alter table public.combistato_readings
  add column if not exists phase_total_s integer;

comment on column public.combistato_readings.phase is
  'Bloque que está corriendo el controlador PRO300 al momento de la lectura (boot/normal/defrost/drip/post_defrost/emerg/off). NULL si el firmware no lo reporta.';

comment on column public.combistato_readings.phase_elapsed_s is
  'Segundos transcurridos dentro de la fase actual (cronómetro del firmware).';

comment on column public.combistato_readings.phase_total_s is
  'Duración total prevista de la fase (0 si la fase no tiene timeout fijo).';

notify pgrst, 'reload schema';
