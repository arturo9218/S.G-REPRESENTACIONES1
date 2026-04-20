-- Rompe la recursión infinita en RLS entre `devices` y `device_members`
-- (error: infinite recursion detected in policy for relation "devices").
--
-- Causa (029): `member_select_devices` en `devices` hace EXISTS sobre
-- `device_members`, y las políticas dm_* en `device_members` hacían EXISTS
-- sobre `devices` → ciclo al evaluar permisos.
--
-- Solución: denormalizar `owner_user_id` en `device_members` y reescribir
-- las políticas dm_* para no consultar `devices`. Un trigger SECURITY DEFINER
-- rellena `owner_user_id` en INSERT/UPDATE de `device_id`.
--
-- Ejecutar en Supabase SQL Editor después de 029 (y 030 si aplica).

-- ---------------------------------------------------------------------------
-- Columna + relleno + trigger
-- ---------------------------------------------------------------------------

alter table public.device_members
  add column if not exists owner_user_id uuid;

create or replace function public._backfill_device_members_owner()
returns void
language sql
security definer
set search_path = public
as $$
  update public.device_members dm
  set owner_user_id = d.owner_user_id
  from public.devices d
  where dm.device_id = d.id
    and (dm.owner_user_id is distinct from d.owner_user_id);
$$;

select public._backfill_device_members_owner();

drop function if exists public._backfill_device_members_owner();

create or replace function public.device_members_set_owner_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.owner_user_id := (
    select d.owner_user_id
    from public.devices d
    where d.id = new.device_id
    limit 1
  );
  if new.owner_user_id is null then
    raise exception 'device_id not found in devices' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists device_members_set_owner_user_id_trg on public.device_members;
create trigger device_members_set_owner_user_id_trg
  before insert or update of device_id on public.device_members
  for each row
  execute function public.device_members_set_owner_user_id();

comment on column public.device_members.owner_user_id is
  'Dueño del equipo (copia de devices.owner_user_id); evita RLS recursivo devices↔device_members.';

create index if not exists idx_device_members_owner
  on public.device_members (owner_user_id);

-- ---------------------------------------------------------------------------
-- Políticas device_members (sin subconsulta a public.devices)
-- ---------------------------------------------------------------------------

drop policy if exists "dm_select_owner_member_admin" on public.device_members;
create policy "dm_select_owner_member_admin"
  on public.device_members for select
  using (
    public.is_app_admin()
    or member_user_id = auth.uid()
    or owner_user_id = auth.uid()
  );

drop policy if exists "dm_insert_owner_admin" on public.device_members;
create policy "dm_insert_owner_admin"
  on public.device_members for insert
  with check (
    public.is_app_admin()
    or owner_user_id = auth.uid()
  );

drop policy if exists "dm_update_owner_admin" on public.device_members;
create policy "dm_update_owner_admin"
  on public.device_members for update
  using (
    public.is_app_admin()
    or owner_user_id = auth.uid()
  )
  with check (
    public.is_app_admin()
    or owner_user_id = auth.uid()
  );

drop policy if exists "dm_delete_owner_admin_or_self" on public.device_members;
create policy "dm_delete_owner_admin_or_self"
  on public.device_members for delete
  using (
    public.is_app_admin()
    or member_user_id = auth.uid()
    or owner_user_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Invitaciones: rellenar owner_user_id en el INSERT (además del trigger)
-- ---------------------------------------------------------------------------

create or replace function public.add_device_member_by_email(
  p_device_id uuid,
  p_email text,
  p_role text
)
returns void
language plpgsql
security definer
set search_path to public, auth
as $$
declare
  owner_uid uuid;
  member_uid uuid;
  invite_email_norm text := lower(trim(p_email));
begin
  if p_role not in ('viewer', 'editor') then
    raise exception 'Rol inválido' using errcode = '22023';
  end if;

  owner_uid := (
    select d.owner_user_id from public.devices d where d.id = p_device_id limit 1
  );

  if owner_uid is null then
    raise exception 'Equipo no encontrado' using errcode = 'P0002';
  end if;

  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if auth.uid() is distinct from owner_uid and not public.is_app_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  member_uid := (
    select u.id
    from auth.users u
    where lower(trim(u.email)) = invite_email_norm
    limit 1
  );

  if member_uid is null then
    raise exception 'No hay usuario registrado con ese email' using errcode = 'P0002';
  end if;

  if member_uid = owner_uid then
    raise exception 'El dueño ya tiene acceso completo' using errcode = '23514';
  end if;

  insert into public.device_members (device_id, member_user_id, role, invited_by, owner_user_id)
  values (p_device_id, member_uid, p_role, auth.uid(), owner_uid)
  on conflict (device_id, member_user_id) do update
    set role = excluded.role,
        invited_by = excluded.invited_by,
        owner_user_id = excluded.owner_user_id;
end;
$$;

grant execute on function public.add_device_member_by_email(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
