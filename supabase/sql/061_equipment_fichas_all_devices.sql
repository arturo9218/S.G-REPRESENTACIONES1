-- Ficha técnica para todos los equipos (panel/PRO400, PRO300, PR500, Datalogger).
-- Ejecutar después de 022_device_equipment_fichas.sql

-- ---------------------------------------------------------------------------
-- Tipo de equipo (device = fila en public.devices, incluye PRO400)
-- ---------------------------------------------------------------------------

alter table public.device_equipment_fichas
  add column if not exists equipment_kind text not null default 'device';

alter table public.device_equipment_log
  add column if not exists equipment_kind text not null default 'device';

alter table public.device_equipment_photos
  add column if not exists equipment_kind text not null default 'device';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'device_equipment_fichas_equipment_kind_check'
  ) then
    alter table public.device_equipment_fichas
      add constraint device_equipment_fichas_equipment_kind_check
      check (equipment_kind in ('device', 'pr500', 'combistato', 'datalogger'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'device_equipment_log_equipment_kind_check'
  ) then
    alter table public.device_equipment_log
      add constraint device_equipment_log_equipment_kind_check
      check (equipment_kind in ('device', 'pr500', 'combistato', 'datalogger'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'device_equipment_photos_equipment_kind_check'
  ) then
    alter table public.device_equipment_photos
      add constraint device_equipment_photos_equipment_kind_check
      check (equipment_kind in ('device', 'pr500', 'combistato', 'datalogger'));
  end if;
end $$;

-- Quitar FK estricta a devices: PR500 / combistato / datalogger usan su propio UUID
alter table public.device_equipment_fichas
  drop constraint if exists device_equipment_fichas_device_id_fkey;

alter table public.device_equipment_log
  drop constraint if exists device_equipment_log_device_id_fkey;

alter table public.device_equipment_photos
  drop constraint if exists device_equipment_photos_device_id_fkey;

create index if not exists device_equipment_fichas_entity_idx
  on public.device_equipment_fichas (equipment_kind, device_id);

-- ---------------------------------------------------------------------------
-- Dueño del equipo según tipo
-- ---------------------------------------------------------------------------

create or replace function public.user_owns_equipment_entity(p_kind text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'device' then exists (
      select 1 from public.devices d
      where d.id = p_id and d.owner_user_id = auth.uid()
    )
    when 'pr500' then exists (
      select 1 from public.pr500_controllers p
      where p.id = p_id and p.owner_user_id = auth.uid()
    )
    when 'combistato' then exists (
      select 1 from public.combistatos c
      where c.id = p_id and c.owner_user_id = auth.uid()
    )
    when 'datalogger' then exists (
      select 1 from public.datalogger_controllers dl
      where dl.id = p_id and dl.owner_user_id = auth.uid()
    )
    else false
  end;
$$;

revoke all on function public.user_owns_equipment_entity(text, uuid) from public;
grant execute on function public.user_owns_equipment_entity(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS fichas
-- ---------------------------------------------------------------------------

drop policy if exists "owner_select_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_select_equipment_fichas"
  on public.device_equipment_fichas for select
  using (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_insert_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_insert_equipment_fichas"
  on public.device_equipment_fichas for insert
  with check (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_update_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_update_equipment_fichas"
  on public.device_equipment_fichas for update
  using (public.user_owns_equipment_entity(equipment_kind, device_id))
  with check (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_delete_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_delete_equipment_fichas"
  on public.device_equipment_fichas for delete
  using (public.user_owns_equipment_entity(equipment_kind, device_id));

-- Log
drop policy if exists "owner_select_equipment_log" on public.device_equipment_log;
create policy "owner_select_equipment_log"
  on public.device_equipment_log for select
  using (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_insert_equipment_log" on public.device_equipment_log;
create policy "owner_insert_equipment_log"
  on public.device_equipment_log for insert
  with check (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_update_equipment_log" on public.device_equipment_log;
create policy "owner_update_equipment_log"
  on public.device_equipment_log for update
  using (public.user_owns_equipment_entity(equipment_kind, device_id))
  with check (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_delete_equipment_log" on public.device_equipment_log;
create policy "owner_delete_equipment_log"
  on public.device_equipment_log for delete
  using (public.user_owns_equipment_entity(equipment_kind, device_id));

-- Photos metadata
drop policy if exists "owner_select_equipment_photos" on public.device_equipment_photos;
create policy "owner_select_equipment_photos"
  on public.device_equipment_photos for select
  using (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_insert_equipment_photos" on public.device_equipment_photos;
create policy "owner_insert_equipment_photos"
  on public.device_equipment_photos for insert
  with check (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_update_equipment_photos" on public.device_equipment_photos;
create policy "owner_update_equipment_photos"
  on public.device_equipment_photos for update
  using (public.user_owns_equipment_entity(equipment_kind, device_id))
  with check (public.user_owns_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_delete_equipment_photos" on public.device_equipment_photos;
create policy "owner_delete_equipment_photos"
  on public.device_equipment_photos for delete
  using (public.user_owns_equipment_entity(equipment_kind, device_id));

-- ---------------------------------------------------------------------------
-- Storage: fotos de ficha para cualquier equipo del usuario
-- ---------------------------------------------------------------------------

drop policy if exists "equipment_photos_select" on storage.objects;
create policy "equipment_photos_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'equipment-photos'
    and (
      split_part(name, '/', 1) in (
        select id::text from public.devices where owner_user_id = auth.uid()
        union
        select id::text from public.pr500_controllers where owner_user_id = auth.uid()
        union
        select id::text from public.combistatos where owner_user_id = auth.uid()
        union
        select id::text from public.datalogger_controllers where owner_user_id = auth.uid()
      )
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
      split_part(name, '/', 1) in (
        select id::text from public.devices where owner_user_id = auth.uid()
        union
        select id::text from public.pr500_controllers where owner_user_id = auth.uid()
        union
        select id::text from public.combistatos where owner_user_id = auth.uid()
        union
        select id::text from public.datalogger_controllers where owner_user_id = auth.uid()
      )
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
      split_part(name, '/', 1) in (
        select id::text from public.devices where owner_user_id = auth.uid()
        union
        select id::text from public.pr500_controllers where owner_user_id = auth.uid()
        union
        select id::text from public.combistatos where owner_user_id = auth.uid()
        union
        select id::text from public.datalogger_controllers where owner_user_id = auth.uid()
      )
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
      split_part(name, '/', 1) in (
        select id::text from public.devices where owner_user_id = auth.uid()
        union
        select id::text from public.pr500_controllers where owner_user_id = auth.uid()
        union
        select id::text from public.combistatos where owner_user_id = auth.uid()
        union
        select id::text from public.datalogger_controllers where owner_user_id = auth.uid()
      )
      or public.is_app_admin()
    )
  );

comment on column public.device_equipment_fichas.equipment_kind is
  'device = public.devices (panel o PRO400); pr500; combistato (PRO300); datalogger';
