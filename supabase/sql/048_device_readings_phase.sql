-- PRO400 / paneles con control: fase y cronómetro en device_readings (como combistato_readings).
-- Ejecutar después de 043_device_readings_relays.sql

alter table public.device_readings
  add column if not exists phase text;

alter table public.device_readings
  add column if not exists phase_elapsed_s integer;

alter table public.device_readings
  add column if not exists phase_total_s integer;

comment on column public.device_readings.phase is
  'Fase del controlador (boot/normal/defrost/drip/emerg/off). NULL si el firmware no la reporta.';

notify pgrst, 'reload schema';
