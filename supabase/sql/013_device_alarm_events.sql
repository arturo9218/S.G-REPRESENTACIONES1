-- Historial de alarmas (umbral / desconectado) para consultar cuándo se dispararon.
-- Inserción solo desde Edge Functions (service_role). El dueño y el admin pueden leer y borrar.
-- Requisito: 011_admin_app.sql + 012_admin_emails.sql (is_app_admin).

-- Administrador: lecturas insert/update/delete (además de la política solo-lectura previa).
drop policy if exists "admin_manage_readings" on public.device_readings;
create policy "admin_manage_readings"
  on public.device_readings for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

create table if not exists public.device_alarm_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  triggered_at timestamptz not null default now(),
  kind text not null
    constraint device_alarm_events_kind_check
      check (kind in ('temp_breach', 'offline')),
  message text not null,
  detail text,
  temp1_c double precision
);

comment on table public.device_alarm_events is 'Registro cuando se dispara alarma (push o mismo criterio de aviso); el usuario puede borrar tras revisar.';

create index if not exists idx_device_alarm_events_owner_triggered
  on public.device_alarm_events (owner_user_id, triggered_at desc);

create index if not exists idx_device_alarm_events_device
  on public.device_alarm_events (device_id, triggered_at desc);

alter table public.device_alarm_events enable row level security;

drop policy if exists "owner selects own alarm events" on public.device_alarm_events;
create policy "owner selects own alarm events"
  on public.device_alarm_events for select
  using (auth.uid() = owner_user_id);

drop policy if exists "owner deletes own alarm events" on public.device_alarm_events;
create policy "owner deletes own alarm events"
  on public.device_alarm_events for delete
  using (auth.uid() = owner_user_id);

drop policy if exists "admin_select_alarm_events" on public.device_alarm_events;
create policy "admin_select_alarm_events"
  on public.device_alarm_events for select
  using (public.is_app_admin());

drop policy if exists "admin_delete_alarm_events" on public.device_alarm_events;
create policy "admin_delete_alarm_events"
  on public.device_alarm_events for delete
  using (public.is_app_admin());

grant select, delete on public.device_alarm_events to authenticated;

notify pgrst, 'reload schema';
