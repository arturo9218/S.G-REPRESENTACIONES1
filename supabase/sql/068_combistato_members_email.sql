-- Email visible del invitado en la lista "Compartir PRO300" (dueño).
-- Ejecutar después de 066_combistato_members.sql.

alter table public.combistato_members
  add column if not exists member_email text;

comment on column public.combistato_members.member_email is
  'Email del invitado (copia al invitar); solo visible para dueño/admin vía RLS de combistato_members.';

-- Rellenar filas ya existentes
update public.combistato_members cm
set member_email = lower(trim(u.email::text))
from auth.users u
where u.id = cm.member_user_id
  and (cm.member_email is null or trim(cm.member_email) = '');

create or replace function public.add_combistato_member_by_email(
  p_combistato_id uuid,
  p_email text,
  p_can_view boolean default true,
  p_can_charts boolean default true,
  p_can_edit_params boolean default false,
  p_can_ficha boolean default false,
  p_can_commands boolean default false,
  p_can_push boolean default false
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
  owner_uid := (
    select c.owner_user_id from public.combistatos c where c.id = p_combistato_id limit 1
  );
  if owner_uid is null then
    raise exception 'PRO300 no encontrado' using errcode = 'P0002';
  end if;
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if auth.uid() is distinct from owner_uid and not public.is_app_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  member_uid := (
    select u.id from auth.users u where lower(trim(u.email)) = invite_email_norm limit 1
  );
  if member_uid is null then
    raise exception 'No hay usuario registrado con ese email' using errcode = 'P0002';
  end if;
  if member_uid = owner_uid then
    raise exception 'El dueño ya tiene acceso completo' using errcode = '23514';
  end if;

  insert into public.combistato_members (
    combistato_id,
    member_user_id,
    owner_user_id,
    invited_by,
    member_email,
    can_view,
    can_charts,
    can_edit_params,
    can_ficha,
    can_commands,
    can_push
  )
  values (
    p_combistato_id,
    member_uid,
    owner_uid,
    auth.uid(),
    invite_email_norm,
    coalesce(p_can_view, true),
    coalesce(p_can_charts, true),
    coalesce(p_can_edit_params, false),
    coalesce(p_can_ficha, false),
    coalesce(p_can_commands, false),
    coalesce(p_can_push, false)
  )
  on conflict (combistato_id, member_user_id) do update
    set
      member_email = excluded.member_email,
      can_view = excluded.can_view,
      can_charts = excluded.can_charts,
      can_edit_params = excluded.can_edit_params,
      can_ficha = excluded.can_ficha,
      can_commands = excluded.can_commands,
      can_push = excluded.can_push,
      invited_by = excluded.invited_by,
      owner_user_id = excluded.owner_user_id;
end;
$$;

grant execute on function public.add_combistato_member_by_email(
  uuid, text, boolean, boolean, boolean, boolean, boolean, boolean
) to authenticated;

notify pgrst, 'reload schema';
