-- Controladores de presión PR500 (3 etapas de compresores + alarmas).
-- Misma idea que `combistatos`: `module_id` + `device_token_hash`, `params` JSONB (F01–F21).
-- Ejecutar en Supabase SQL Editor después de 033 y 031.

create table if not exists public.pr500_controllers (
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
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'pr500_controllers_module_id_key'
  ) then
    create unique index pr500_controllers_module_id_key on public.pr500_controllers (module_id);
  end if;
end $$;

comment on table public.pr500_controllers is
  'Control PR500 por presión (setpoint, diferenciales, etapas). Conexión: module_id + api_key igual que devices/combistatos.';

create index if not exists idx_pr500_controllers_owner on public.pr500_controllers (owner_user_id);
create index if not exists idx_pr500_controllers_updated on public.pr500_controllers (updated_at desc);
create index if not exists idx_pr500_controllers_last_seen on public.pr500_controllers (last_seen_at desc nulls last);

alter table public.pr500_controllers enable row level security;

drop policy if exists "pr500_select" on public.pr500_controllers;
create policy "pr500_select"
  on public.pr500_controllers for select
  using (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "pr500_insert" on public.pr500_controllers;
create policy "pr500_insert"
  on public.pr500_controllers for insert
  with check (auth.uid() = owner_user_id);

drop policy if exists "pr500_update" on public.pr500_controllers;
create policy "pr500_update"
  on public.pr500_controllers for update
  using (auth.uid() = owner_user_id or public.is_app_admin())
  with check (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "pr500_delete" on public.pr500_controllers;
create policy "pr500_delete"
  on public.pr500_controllers for delete
  using (auth.uid() = owner_user_id or public.is_app_admin());

notify pgrst, 'reload schema';
