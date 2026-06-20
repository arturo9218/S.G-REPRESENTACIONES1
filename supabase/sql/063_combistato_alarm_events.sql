-- Historial de alarmas PRO300 (misma idea que device_alarm_events).
-- Inserción desde Edge Functions (service_role).

create table if not exists public.combistato_alarm_events (
  id uuid primary key default gen_random_uuid(),
  combistato_id uuid not null references public.combistatos (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  triggered_at timestamptz not null default now(),
  kind text not null
    constraint combistato_alarm_events_kind_check
      check (kind in ('temp_breach', 'offline')),
  message text not null,
  detail text,
  temp1_c double precision,
  temp2_c double precision
);

comment on table public.combistato_alarm_events is
  'Registro cuando se dispara alarma push en PRO300; el dueño puede borrar tras revisar.';

create index if not exists idx_combistato_alarm_events_owner
  on public.combistato_alarm_events (owner_user_id, triggered_at desc);

create index if not exists idx_combistato_alarm_events_combistato
  on public.combistato_alarm_events (combistato_id, triggered_at desc);

alter table public.combistato_alarm_events enable row level security;

drop policy if exists "combistato_alarm_events_select" on public.combistato_alarm_events;
create policy "combistato_alarm_events_select"
  on public.combistato_alarm_events for select
  using (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "combistato_alarm_events_delete" on public.combistato_alarm_events;
create policy "combistato_alarm_events_delete"
  on public.combistato_alarm_events for delete
  using (auth.uid() = owner_user_id or public.is_app_admin());

grant select, delete on public.combistato_alarm_events to authenticated;

notify pgrst, 'reload schema';
