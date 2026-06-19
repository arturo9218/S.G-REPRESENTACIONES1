-- Telemetría Datalogger: 6 temperaturas, 3 consumos (A/W), 2 presiones.
-- Rellenado por Edge Function ingest-reading cuando el POST corresponde a datalogger_controllers.
-- Ejecutar después de 058_datalogger_controllers.sql.

create table if not exists public.datalogger_readings (
  id bigserial primary key,
  datalogger_id uuid not null references public.datalogger_controllers (id) on delete cascade,
  created_at timestamptz not null,
  temp1_c double precision,
  temp2_c double precision,
  temp3_c double precision,
  temp4_c double precision,
  temp5_c double precision,
  temp6_c double precision,
  current1_a double precision,
  current2_a double precision,
  current3_a double precision,
  power1_w double precision,
  power2_w double precision,
  power3_w double precision,
  press1_bar double precision,
  press2_bar double precision
);

create index if not exists idx_datalogger_readings_did_created
  on public.datalogger_readings (datalogger_id, created_at desc);

comment on table public.datalogger_readings is
  'Serie temporal Datalogger: 6× temp °C, 3× corriente/potencia, 2× presión bar.';

alter table public.datalogger_readings enable row level security;

drop policy if exists "datalogger_readings_select" on public.datalogger_readings;
create policy "datalogger_readings_select"
  on public.datalogger_readings for select
  using (
    exists (
      select 1
      from public.datalogger_controllers d
      where d.id = datalogger_readings.datalogger_id
        and (d.owner_user_id = auth.uid() or public.is_app_admin())
    )
  );

notify pgrst, 'reload schema';
