-- Corrección de lectura por sensor (suma en °C al valor que envía el ESP).
-- Ej.: si el DS18B20 marca 2 °C de más, poné -2 en temp1_offset_c.

alter table public.device_thresholds
  add column if not exists temp1_offset_c double precision not null default 0;

alter table public.device_thresholds
  add column if not exists temp2_offset_c double precision not null default 0;

alter table public.device_thresholds
  add column if not exists temp3_offset_c double precision not null default 0;

notify pgrst, 'reload schema';
