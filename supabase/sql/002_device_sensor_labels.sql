-- Nombres personalizados para canales de temperatura (UI).
-- Ejecutar en Supabase SQL Editor después de 001.

alter table public.devices
  add column if not exists sensor_1_label text;

alter table public.devices
  add column if not exists sensor_2_label text;

comment on column public.devices.sensor_1_label is 'Etiqueta UI para temp1 (ej. Evaporador)';
comment on column public.devices.sensor_2_label is 'Etiqueta UI para temp2';
