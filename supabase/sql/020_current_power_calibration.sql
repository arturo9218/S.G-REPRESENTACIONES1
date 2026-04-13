-- Corrección de consumo (corriente / potencia) como offset en device_thresholds.
-- Valores crudos en device_readings para recalcular en el panel al cambiar el offset.
-- Ejecutar en Supabase SQL Editor después de migraciones anteriores.
--
-- Si ves "column ... does not exist" al comentar: ejecutá solo el bloque DO primero,
-- verificá en Table Editor que aparezcan las columnas, y después los COMMENT.

-- device_thresholds: offsets (compatible con PG sin depender solo de IF NOT EXISTS en ADD)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'device_thresholds'
      and column_name = 'current_offset_a'
  ) then
    alter table public.device_thresholds
      add column current_offset_a double precision not null default 0;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'device_thresholds'
      and column_name = 'power_offset_w'
  ) then
    alter table public.device_thresholds
      add column power_offset_w double precision not null default 0;
  end if;
end $$;

comment on column public.device_thresholds.current_offset_a is 'Suma en A al valor de corriente del ESP (ingesta)';
comment on column public.device_thresholds.power_offset_w is 'Suma en W al valor de potencia del ESP (ingesta)';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'device_readings'
      and column_name = 'current_a_raw'
  ) then
    alter table public.device_readings
      add column current_a_raw double precision;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'device_readings'
      and column_name = 'power_w_raw'
  ) then
    alter table public.device_readings
      add column power_w_raw double precision;
  end if;
end $$;

comment on column public.device_readings.current_a is 'Corriente RMS corregida (A)';
comment on column public.device_readings.current_a_raw is 'Corriente enviada por el ESP antes de current_offset_a';
comment on column public.device_readings.power_w is 'Potencia corregida (W)';
comment on column public.device_readings.power_w_raw is 'Potencia enviada por el ESP antes de power_offset_w';
