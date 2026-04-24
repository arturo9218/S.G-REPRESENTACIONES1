-- Parámetros de combistato por equipo (panel / nube), alineados al JSON del firmware ESP32
-- (`/combistato.json` en LittleFS). Ejecutar en Supabase SQL Editor después de 029/031.
--
-- La app guarda/lee `params` como objeto con claves F01, F02, … (mismo esquema que el .ino).

create table if not exists public.device_combistato (
  device_id uuid primary key references public.devices (id) on delete cascade,
  params jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.device_combistato is 'Configuración combistato F01–F55 por dispositivo; sincronizar con firmware ESP32 vía JSON.';

create index if not exists idx_device_combistato_updated
  on public.device_combistato (updated_at desc);

alter table public.device_combistato enable row level security;

drop policy if exists "dcomb_select_access" on public.device_combistato;
create policy "dcomb_select_access"
  on public.device_combistato for select
  using (public.user_can_access_device(device_id));

drop policy if exists "dcomb_insert_editor" on public.device_combistato;
create policy "dcomb_insert_editor"
  on public.device_combistato for insert
  with check (public.user_can_edit_device(device_id));

drop policy if exists "dcomb_update_editor" on public.device_combistato;
create policy "dcomb_update_editor"
  on public.device_combistato for update
  using (public.user_can_edit_device(device_id))
  with check (public.user_can_edit_device(device_id));

drop policy if exists "dcomb_delete_editor" on public.device_combistato;
create policy "dcomb_delete_editor"
  on public.device_combistato for delete
  using (public.user_can_edit_device(device_id));
