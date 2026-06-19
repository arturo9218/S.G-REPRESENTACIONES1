-- Valores crudos del ESP32 + corrección en app (AR35–AR48 en params).
-- Ejecutar después de 059_datalogger_readings.sql.

alter table public.datalogger_readings
  add column if not exists temp1_raw_c double precision,
  add column if not exists temp2_raw_c double precision,
  add column if not exists temp3_raw_c double precision,
  add column if not exists temp4_raw_c double precision,
  add column if not exists temp5_raw_c double precision,
  add column if not exists temp6_raw_c double precision,
  add column if not exists current1_raw_a double precision,
  add column if not exists current2_raw_a double precision,
  add column if not exists current3_raw_a double precision,
  add column if not exists power1_raw_w double precision,
  add column if not exists power2_raw_w double precision,
  add column if not exists power3_raw_w double precision,
  add column if not exists press1_raw_bar double precision,
  add column if not exists press2_raw_bar double precision;

comment on column public.datalogger_readings.temp1_raw_c is 'Bruto ESP antes de offset AR35';
comment on column public.datalogger_readings.current1_raw_a is 'Bruto ESP antes de offset AR41';
comment on column public.datalogger_readings.press1_raw_bar is 'Bruto ESP antes de offset AR47';

notify pgrst, 'reload schema';
