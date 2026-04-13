-- Ficha técnica del equipo, bitácora y fotos por dispositivo.
-- Bucket Storage: equipment-photos (ruta: {device_id}/{uuid}.ext)
-- Ejecutar en Supabase SQL Editor.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table if not exists public.device_equipment_sheets (
  device_id uuid primary key references public.devices (id) on delete cascade,
  compressor_text text,
  hp double precision,
  refrigerant text,
  condenser_text text,
  evaporator_text text,
  supply text,
  pump_down boolean not null default false,
  defrost text,
  chamber_type text,
  free_notes text,
  last_maintenance_at timestamptz,
  next_maintenance_at timestamptz,
  maintenance_interval_days integer,
  maintenance_notify_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.device_equipment_sheets is 'Ficha técnica editable por el técnico (un registro por dispositivo).';

create table if not exists public.device_equipment_log (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  occurred_at timestamptz not null,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists device_equipment_log_device_occurred_idx
  on public.device_equipment_log (device_id, occurred_at desc);

comment on table public.device_equipment_log is 'Bitácora: visitas e intervenciones (orden cronológico).';

create table if not exists public.device_equipment_photos (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  storage_path text not null unique,
  sort_order integer not null default 0,
  caption text,
  created_at timestamptz not null default now()
);

create index if not exists device_equipment_photos_device_idx
  on public.device_equipment_photos (device_id, sort_order);

comment on table public.device_equipment_photos is 'Metadatos de fotos en Storage (bucket equipment-photos).';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.device_equipment_sheets enable row level security;
alter table public.device_equipment_log enable row level security;
alter table public.device_equipment_photos enable row level security;

drop policy if exists "owner_select_equipment_sheets" on public.device_equipment_sheets;
create policy "owner_select_equipment_sheets"
  on public.device_equipment_sheets for select
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_sheets.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_insert_equipment_sheets" on public.device_equipment_sheets;
create policy "owner_insert_equipment_sheets"
  on public.device_equipment_sheets for insert
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_sheets.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_update_equipment_sheets" on public.device_equipment_sheets;
create policy "owner_update_equipment_sheets"
  on public.device_equipment_sheets for update
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_sheets.device_id and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_sheets.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_delete_equipment_sheets" on public.device_equipment_sheets;
create policy "owner_delete_equipment_sheets"
  on public.device_equipment_sheets for delete
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_sheets.device_id and d.owner_user_id = auth.uid()
    )
  );

-- Log
drop policy if exists "owner_select_equipment_log" on public.device_equipment_log;
create policy "owner_select_equipment_log"
  on public.device_equipment_log for select
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_log.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_insert_equipment_log" on public.device_equipment_log;
create policy "owner_insert_equipment_log"
  on public.device_equipment_log for insert
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_log.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_update_equipment_log" on public.device_equipment_log;
create policy "owner_update_equipment_log"
  on public.device_equipment_log for update
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_log.device_id and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_log.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_delete_equipment_log" on public.device_equipment_log;
create policy "owner_delete_equipment_log"
  on public.device_equipment_log for delete
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_log.device_id and d.owner_user_id = auth.uid()
    )
  );

-- Photos metadata
drop policy if exists "owner_select_equipment_photos" on public.device_equipment_photos;
create policy "owner_select_equipment_photos"
  on public.device_equipment_photos for select
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_photos.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_insert_equipment_photos" on public.device_equipment_photos;
create policy "owner_insert_equipment_photos"
  on public.device_equipment_photos for insert
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_photos.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_update_equipment_photos" on public.device_equipment_photos;
create policy "owner_update_equipment_photos"
  on public.device_equipment_photos for update
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_photos.device_id and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_photos.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_delete_equipment_photos" on public.device_equipment_photos;
create policy "owner_delete_equipment_photos"
  on public.device_equipment_photos for delete
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_photos.device_id and d.owner_user_id = auth.uid()
    )
  );

-- Admin (misma función que en 011/012)
drop policy if exists "admin_select_equipment_sheets" on public.device_equipment_sheets;
create policy "admin_select_equipment_sheets"
  on public.device_equipment_sheets for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_equipment_sheets" on public.device_equipment_sheets;
create policy "admin_manage_equipment_sheets"
  on public.device_equipment_sheets for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "admin_select_equipment_log" on public.device_equipment_log;
create policy "admin_select_equipment_log"
  on public.device_equipment_log for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_equipment_log" on public.device_equipment_log;
create policy "admin_manage_equipment_log"
  on public.device_equipment_log for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "admin_select_equipment_photos" on public.device_equipment_photos;
create policy "admin_select_equipment_photos"
  on public.device_equipment_photos for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_equipment_photos" on public.device_equipment_photos;
create policy "admin_manage_equipment_photos"
  on public.device_equipment_photos for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- Storage bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'equipment-photos',
  'equipment-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "equipment_photos_select" on storage.objects;
create policy "equipment_photos_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'equipment-photos'
    and (
      split_part(name, '/', 1) in (select id::text from public.devices where owner_user_id = auth.uid())
      or public.is_app_admin()
    )
  );

drop policy if exists "equipment_photos_insert" on storage.objects;
create policy "equipment_photos_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'equipment-photos'
    and (
      split_part(name, '/', 1) in (select id::text from public.devices where owner_user_id = auth.uid())
      or public.is_app_admin()
    )
  );

drop policy if exists "equipment_photos_update" on storage.objects;
create policy "equipment_photos_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'equipment-photos'
    and (
      split_part(name, '/', 1) in (select id::text from public.devices where owner_user_id = auth.uid())
      or public.is_app_admin()
    )
  );

drop policy if exists "equipment_photos_delete" on storage.objects;
create policy "equipment_photos_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'equipment-photos'
    and (
      split_part(name, '/', 1) in (select id::text from public.devices where owner_user_id = auth.uid())
      or public.is_app_admin()
    )
  );

-- Lectura pública de objetos (bucket público; URLs estáticas para PDF / img)
drop policy if exists "equipment_photos_public_read" on storage.objects;
create policy "equipment_photos_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'equipment-photos');
