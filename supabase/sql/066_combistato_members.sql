-- Miembros invitados a PRO300 (combistatos) con permisos granulares.
-- Ejecutar después de 033_combistatos.sql y 061_equipment_fichas_all_devices.sql.

create table if not exists public.combistato_members (
  combistato_id uuid not null references public.combistatos (id) on delete cascade,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  invited_by uuid references auth.users (id),
  can_view boolean not null default true,
  can_charts boolean not null default true,
  can_edit_params boolean not null default false,
  can_ficha boolean not null default false,
  can_commands boolean not null default false,
  can_push boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (combistato_id, member_user_id)
);

create index if not exists idx_combistato_members_member
  on public.combistato_members (member_user_id);

create index if not exists idx_combistato_members_owner
  on public.combistato_members (owner_user_id);

comment on table public.combistato_members is
  'Usuarios invitados a un PRO300: permisos por acción (ver, gráficos, parámetros, ficha, comandos, push).';

alter table public.combistato_members enable row level security;

-- ---------------------------------------------------------------------------
-- Trigger: owner_user_id desde combistatos (evita RLS recursivo)
-- ---------------------------------------------------------------------------

create or replace function public.combistato_members_set_owner_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.owner_user_id := (
    select c.owner_user_id from public.combistatos c where c.id = new.combistato_id limit 1
  );
  if new.owner_user_id is null then
    raise exception 'combistato_id not found' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists combistato_members_set_owner_user_id_trg on public.combistato_members;
create trigger combistato_members_set_owner_user_id_trg
  before insert or update of combistato_id on public.combistato_members
  for each row
  execute function public.combistato_members_set_owner_user_id();

-- ---------------------------------------------------------------------------
-- Funciones de acceso
-- ---------------------------------------------------------------------------

create or replace function public.user_can_access_combistato(p_combistato_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.combistatos c
      where c.id = p_combistato_id and c.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.combistato_members m
      where m.combistato_id = p_combistato_id
        and m.member_user_id = auth.uid()
        and m.can_view
    );
$$;

create or replace function public.user_can_charts_combistato(p_combistato_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.combistatos c
      where c.id = p_combistato_id and c.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.combistato_members m
      where m.combistato_id = p_combistato_id
        and m.member_user_id = auth.uid()
        and m.can_charts
    );
$$;

create or replace function public.user_can_edit_combistato_params(p_combistato_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.combistatos c
      where c.id = p_combistato_id and c.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.combistato_members m
      where m.combistato_id = p_combistato_id
        and m.member_user_id = auth.uid()
        and m.can_edit_params
    );
$$;

create or replace function public.user_can_edit_combistato_ficha(p_combistato_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.combistatos c
      where c.id = p_combistato_id and c.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.combistato_members m
      where m.combistato_id = p_combistato_id
        and m.member_user_id = auth.uid()
        and m.can_ficha
    );
$$;

create or replace function public.user_can_combistato_commands(p_combistato_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.combistatos c
      where c.id = p_combistato_id and c.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.combistato_members m
      where m.combistato_id = p_combistato_id
        and m.member_user_id = auth.uid()
        and m.can_commands
    );
$$;

grant execute on function public.user_can_access_combistato(uuid) to authenticated;
grant execute on function public.user_can_charts_combistato(uuid) to authenticated;
grant execute on function public.user_can_edit_combistato_params(uuid) to authenticated;
grant execute on function public.user_can_edit_combistato_ficha(uuid) to authenticated;
grant execute on function public.user_can_combistato_commands(uuid) to authenticated;

-- Push: dueño + miembros con can_push + admins (service_role desde Edge Functions)
create or replace function public.get_combistato_push_user_ids(
  p_combistato_id uuid,
  p_owner_user_id uuid
)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select p_owner_user_id as user_id
  where p_owner_user_id is not null
  union
  select m.member_user_id
  from public.combistato_members m
  where m.combistato_id = p_combistato_id and m.can_push
  union
  select a.user_id from public.get_admin_user_ids_for_push() a;
$$;

revoke all on function public.get_combistato_push_user_ids(uuid, uuid) from public;
grant execute on function public.get_combistato_push_user_ids(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS combistato_members
-- ---------------------------------------------------------------------------

drop policy if exists "cm_select" on public.combistato_members;
create policy "cm_select"
  on public.combistato_members for select
  using (
    public.is_app_admin()
    or member_user_id = auth.uid()
    or owner_user_id = auth.uid()
  );

drop policy if exists "cm_insert" on public.combistato_members;
create policy "cm_insert"
  on public.combistato_members for insert
  with check (
    public.is_app_admin()
    or owner_user_id = auth.uid()
  );

drop policy if exists "cm_update" on public.combistato_members;
create policy "cm_update"
  on public.combistato_members for update
  using (
    public.is_app_admin()
    or owner_user_id = auth.uid()
  )
  with check (
    public.is_app_admin()
    or owner_user_id = auth.uid()
  );

drop policy if exists "cm_delete" on public.combistato_members;
create policy "cm_delete"
  on public.combistato_members for delete
  using (
    public.is_app_admin()
    or member_user_id = auth.uid()
    or owner_user_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- RLS combistatos (lectura compartida; edición solo dueño o can_edit_params)
-- ---------------------------------------------------------------------------

drop policy if exists "combistatos_select" on public.combistatos;
create policy "combistatos_select"
  on public.combistatos for select
  using (public.user_can_access_combistato(id));

drop policy if exists "combistatos_update" on public.combistatos;
create policy "combistatos_update"
  on public.combistatos for update
  using (public.user_can_edit_combistato_params(id))
  with check (public.user_can_edit_combistato_params(id));

-- insert/delete sin cambios (solo dueño en políticas originales de 033)

-- ---------------------------------------------------------------------------
-- RLS combistato_readings
-- ---------------------------------------------------------------------------

drop policy if exists "combistato_readings_select" on public.combistato_readings;
create policy "combistato_readings_select"
  on public.combistato_readings for select
  using (public.user_can_access_combistato(combistato_id));

-- ---------------------------------------------------------------------------
-- RLS combistato_alarm_events (miembros con can_view)
-- ---------------------------------------------------------------------------

drop policy if exists "combistato_alarm_events_select" on public.combistato_alarm_events;
create policy "combistato_alarm_events_select"
  on public.combistato_alarm_events for select
  using (
    auth.uid() = owner_user_id
    or public.is_app_admin()
    or public.user_can_access_combistato(combistato_id)
  );

-- ---------------------------------------------------------------------------
-- Ficha técnica PRO300 para miembros con can_ficha
-- ---------------------------------------------------------------------------

create or replace function public.user_can_access_equipment_entity(p_kind text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'combistato' then public.user_can_edit_combistato_ficha(p_id)
    else public.user_owns_equipment_entity(p_kind, p_id)
  end;
$$;

create or replace function public.user_can_view_equipment_entity(p_kind text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'combistato' then public.user_can_edit_combistato_ficha(p_id)
    else public.user_owns_equipment_entity(p_kind, p_id)
  end;
$$;

grant execute on function public.user_can_access_equipment_entity(text, uuid) to authenticated;
grant execute on function public.user_can_view_equipment_entity(text, uuid) to authenticated;

drop policy if exists "owner_select_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_select_equipment_fichas"
  on public.device_equipment_fichas for select
  using (public.user_can_view_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_insert_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_insert_equipment_fichas"
  on public.device_equipment_fichas for insert
  with check (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_update_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_update_equipment_fichas"
  on public.device_equipment_fichas for update
  using (public.user_can_access_equipment_entity(equipment_kind, device_id))
  with check (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_delete_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_delete_equipment_fichas"
  on public.device_equipment_fichas for delete
  using (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_select_equipment_log" on public.device_equipment_log;
create policy "owner_select_equipment_log"
  on public.device_equipment_log for select
  using (public.user_can_view_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_insert_equipment_log" on public.device_equipment_log;
create policy "owner_insert_equipment_log"
  on public.device_equipment_log for insert
  with check (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_update_equipment_log" on public.device_equipment_log;
create policy "owner_update_equipment_log"
  on public.device_equipment_log for update
  using (public.user_can_access_equipment_entity(equipment_kind, device_id))
  with check (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_delete_equipment_log" on public.device_equipment_log;
create policy "owner_delete_equipment_log"
  on public.device_equipment_log for delete
  using (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_select_equipment_photos" on public.device_equipment_photos;
create policy "owner_select_equipment_photos"
  on public.device_equipment_photos for select
  using (public.user_can_view_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_insert_equipment_photos" on public.device_equipment_photos;
create policy "owner_insert_equipment_photos"
  on public.device_equipment_photos for insert
  with check (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_update_equipment_photos" on public.device_equipment_photos;
create policy "owner_update_equipment_photos"
  on public.device_equipment_photos for update
  using (public.user_can_access_equipment_entity(equipment_kind, device_id))
  with check (public.user_can_access_equipment_entity(equipment_kind, device_id));

drop policy if exists "owner_delete_equipment_photos" on public.device_equipment_photos;
create policy "owner_delete_equipment_photos"
  on public.device_equipment_photos for delete
  using (public.user_can_access_equipment_entity(equipment_kind, device_id));

-- Storage: fotos de combistato compartido
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
        union
        select c.id::text
        from public.combistato_members m
        join public.combistatos c on c.id = m.combistato_id
        where m.member_user_id = auth.uid() and m.can_ficha
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
        union
        select c.id::text
        from public.combistato_members m
        join public.combistatos c on c.id = m.combistato_id
        where m.member_user_id = auth.uid() and m.can_ficha
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
        union
        select c.id::text
        from public.combistato_members m
        join public.combistatos c on c.id = m.combistato_id
        where m.member_user_id = auth.uid() and m.can_ficha
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
        union
        select c.id::text
        from public.combistato_members m
        join public.combistatos c on c.id = m.combistato_id
        where m.member_user_id = auth.uid() and m.can_ficha
      )
      or public.is_app_admin()
    )
  );

-- ---------------------------------------------------------------------------
-- Invitar por email
-- ---------------------------------------------------------------------------

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
    coalesce(p_can_view, true),
    coalesce(p_can_charts, true),
    coalesce(p_can_edit_params, false),
    coalesce(p_can_ficha, false),
    coalesce(p_can_commands, false),
    coalesce(p_can_push, false)
  )
  on conflict (combistato_id, member_user_id) do update
    set
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

grant select on public.combistato_members to authenticated;

notify pgrst, 'reload schema';
