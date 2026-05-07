-- Horas de marcha acumuladas (ms totales ON por relé), enviadas por firmware PR500 Stage3 en ingest-reading.
-- Ejecutar en Supabase SQL Editor después de 037_pr500_readings.sql.

alter table public.pr500_readings
  add column if not exists comp1_run_ms bigint,
  add column if not exists comp2_run_ms bigint,
  add column if not exists comp3_run_ms bigint;

comment on column public.pr500_readings.comp1_run_ms is
  'Milisegundos ON acumulados compresor 1 (R1); opcional si el firmware los envía.';
comment on column public.pr500_readings.comp2_run_ms is
  'Milisegundos ON acumulados compresor 2 (R2); opcional si el firmware los envía.';
comment on column public.pr500_readings.comp3_run_ms is
  'Milisegundos ON acumulados compresor 3 (R3); opcional si el firmware los envía.';

notify pgrst, 'reload schema';
