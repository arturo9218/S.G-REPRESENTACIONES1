-- Datalogger AR: hasta 6 temperaturas, 3 consumos, 2 presiones.
-- Misma idea que pr500_controllers: module_id + device_token_hash + params JSONB (AR01…).
-- Ejecutar después de 036_pr500_controllers.sql.

create table if not exists public.datalogger_controllers (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  module_id text,
  name text not null,
  location text,
  device_token_hash text,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'datalogger_controllers_module_id_key'
  ) then
    create unique index datalogger_controllers_module_id_key on public.datalogger_controllers (module_id);
  end if;
end $$;

comment on table public.datalogger_controllers is
  'Datalogger multi-canal (6T + 3 consumo + 2P). Conexión: module_id + api_key como PR500/PRO300.';

create index if not exists idx_datalogger_controllers_owner on public.datalogger_controllers (owner_user_id);
create index if not exists idx_datalogger_controllers_updated on public.datalogger_controllers (updated_at desc);
create index if not exists idx_datalogger_controllers_last_seen on public.datalogger_controllers (last_seen_at desc nulls last);

alter table public.datalogger_controllers enable row level security;

drop policy if exists "datalogger_select" on public.datalogger_controllers;
create policy "datalogger_select"
  on public.datalogger_controllers for select
  using (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "datalogger_insert" on public.datalogger_controllers;
create policy "datalogger_insert"
  on public.datalogger_controllers for insert
  with check (auth.uid() = owner_user_id);

drop policy if exists "datalogger_update" on public.datalogger_controllers;
create policy "datalogger_update"
  on public.datalogger_controllers for update
  using (auth.uid() = owner_user_id or public.is_app_admin())
  with check (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "datalogger_delete" on public.datalogger_controllers;
create policy "datalogger_delete"
  on public.datalogger_controllers for delete
  using (auth.uid() = owner_user_id or public.is_app_admin());

notify pgrst, 'reload schema';
