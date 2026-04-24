-- Historial de telemetría del combistato (2 sondas + estados) para gráficos en la app.
-- Rellenado por Edge Function `ingest-reading` cuando el POST corresponde a `combistatos` (no `devices`).
-- Ejecutar en Supabase SQL Editor después de 034_combistatos_last_seen.sql.

create table if not exists public.combistato_readings (
  id bigserial primary key,
  combistato_id uuid not null references public.combistatos (id) on delete cascade,
  created_at timestamptz not null,
  temp1_c double precision not null,
  temp2_c double precision,
  comp_on boolean not null default false,
  fan_on boolean not null default false,
  defrost_on boolean not null default false,
  door_open boolean not null default false
);

create index if not exists idx_combistato_readings_cid_created
  on public.combistato_readings (combistato_id, created_at desc);

comment on table public.combistato_readings is 'Serie temporal combistato: temperaturas S1/S2 y estados de relés/puerta (ingesta).';

alter table public.combistato_readings enable row level security;

drop policy if exists "combistato_readings_select" on public.combistato_readings;
create policy "combistato_readings_select"
  on public.combistato_readings for select
  using (
    exists (
      select 1
      from public.combistatos c
      where c.id = combistato_readings.combistato_id
        and (c.owner_user_id = auth.uid() or public.is_app_admin())
    )
  );

-- Solo la ingesta con service_role escribe (sin policy INSERT para JWT usuario).
