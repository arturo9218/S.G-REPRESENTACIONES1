-- PR500: telemetría de sonda de succión y resultado de recalentamiento.
-- Ejecutar después de 037/038.

alter table public.pr500_readings
  add column if not exists temp_suction_c double precision,
  add column if not exists superheat_c double precision,
  add column if not exists superheat_ok boolean;

comment on column public.pr500_readings.temp_suction_c is
  'Temperatura de succión (DS18B20) en °C, opcional.';
comment on column public.pr500_readings.superheat_c is
  'Recalentamiento calculado en el PR500 (°C), opcional.';
comment on column public.pr500_readings.superheat_ok is
  'true/false según ventana configurada en parámetros AR33..AR34, opcional.';

notify pgrst, 'reload schema';
