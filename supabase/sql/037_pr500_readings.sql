-- Telemetría PR500: presión + salidas de relé + entradas digitales.
-- Rellenado por Edge Function `ingest-reading` cuando el POST corresponde a `pr500_controllers`.
-- Ejecutar después de 036_pr500_controllers.sql.

create table if not exists public.pr500_readings (
  id bigserial primary key,
  pr500_id uuid not null references public.pr500_controllers (id) on delete cascade,
  created_at timestamptz not null,
  pressure_bar double precision not null,
  comp1_on boolean not null default false,
  comp2_on boolean not null default false,
  comp3_on boolean not null default false,
  alarm_on boolean not null default false,
  di1_ok boolean,
  di2_ok boolean,
  di3_ok boolean,
  di4_ok boolean
);

create index if not exists idx_pr500_readings_pid_created
  on public.pr500_readings (pr500_id, created_at desc);

comment on table public.pr500_readings is
  'Serie temporal PR500: presión (bar), estado compresores R1–R3, alarma R4, térmicos/presostato DI1–DI4.';

alter table public.pr500_readings enable row level security;

drop policy if exists "pr500_readings_select" on public.pr500_readings;
create policy "pr500_readings_select"
  on public.pr500_readings for select
  using (
    exists (
      select 1
      from public.pr500_controllers p
      where p.id = pr500_readings.pr500_id
        and (p.owner_user_id = auth.uid() or public.is_app_admin())
    )
  );

notify pgrst, 'reload schema';
