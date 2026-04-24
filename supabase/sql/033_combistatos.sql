-- Combistatos como entidad propia (sin FK a devices). El usuario puede tener muchos.
-- Parámetros F01–F55 en `params` (JSONB), mismo esquema que `device_combistato` / firmware LittleFS.
-- Se conecta a la app igual que `devices`: `module_id` + `api_key` (token).
-- Ejecutar en Supabase SQL Editor después de 020 (is_app_admin) y 032 si existía el modelo viejo por dispositivo.

create table if not exists public.combistatos (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  module_id text unique,
  name text not null,
  location text,
  device_token_hash text,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.combistatos
  add column if not exists module_id text;

alter table public.combistatos
  add column if not exists device_token_hash text;

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public' and indexname = 'combistatos_module_id_key'
  ) then
    create unique index combistatos_module_id_key on public.combistatos (module_id);
  end if;
end $$;

comment on table public.combistatos is 'Configuración combistato F01–F55 por registro independiente del panel de lecturas; conexión de alta igual a devices (module_id + api_key).';

create index if not exists idx_combistatos_owner
  on public.combistatos (owner_user_id);

create index if not exists idx_combistatos_updated
  on public.combistatos (updated_at desc);

alter table public.combistatos enable row level security;

drop policy if exists "combistatos_select" on public.combistatos;
create policy "combistatos_select"
  on public.combistatos for select
  using (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "combistatos_insert" on public.combistatos;
create policy "combistatos_insert"
  on public.combistatos for insert
  with check (auth.uid() = owner_user_id);

drop policy if exists "combistatos_update" on public.combistatos;
create policy "combistatos_update"
  on public.combistatos for update
  using (auth.uid() = owner_user_id or public.is_app_admin())
  with check (auth.uid() = owner_user_id or public.is_app_admin());

drop policy if exists "combistatos_delete" on public.combistatos;
create policy "combistatos_delete"
  on public.combistatos for delete
  using (auth.uid() = owner_user_id or public.is_app_admin());
