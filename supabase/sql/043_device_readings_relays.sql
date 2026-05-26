-- PRO300 con control: el dispositivo además de temperatura reporta estado de relés.
-- Mismo set de banderas que combistato_readings (comp_on / fan_on / defrost_on / door_open).
-- Columnas opcionales: PRO400 y dispositivos antiguos siguen funcionando sin tocar nada
-- (los campos quedan en NULL si el firmware no los envía).
--
-- Ejecutar en Supabase SQL Editor después de 042_pr500_readings_retention.sql.

alter table public.device_readings
  add column if not exists comp_on boolean;

alter table public.device_readings
  add column if not exists fan_on boolean;

alter table public.device_readings
  add column if not exists defrost_on boolean;

alter table public.device_readings
  add column if not exists door_open boolean;

comment on column public.device_readings.comp_on    is 'Estado del relay de compresor reportado por el dispositivo (PRO300 con control). NULL si no aplica.';
comment on column public.device_readings.fan_on     is 'Estado del relay de ventilador (forzador) reportado por el dispositivo. NULL si no aplica.';
comment on column public.device_readings.defrost_on is 'Estado del relay/ciclo de deshielo reportado por el dispositivo. NULL si no aplica.';
comment on column public.device_readings.door_open  is 'Estado del sensor de puerta (true = abierta) reportado por el dispositivo. NULL si no aplica.';

-- Index parcial para listar/contar rápidamente eventos de compresor en ventanas históricas
-- (no engorda la tabla porque solo indexa filas donde la columna no es NULL).
create index if not exists idx_device_readings_comp_on
  on public.device_readings (device_id, created_at desc)
  where comp_on is not null;

notify pgrst, 'reload schema';
