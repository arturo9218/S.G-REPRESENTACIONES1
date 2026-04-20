-- Miembros por equipo (visor / editor) + marcadores en el gráfico.
-- Ejecutar en Supabase SQL Editor después de las migraciones anteriores (p. ej. 024).
-- Actualiza la autorización de get_device_readings_chart para miembros.
--
-- Si Postgres devuelve "infinite recursion detected in policy for relation devices",
-- ejecutá también `031_device_members_rls_break_recursion.sql` (rompe el ciclo RLS
-- entre policies en `devices` y `device_members`).
--
-- Orden: primero la tabla device_members; las funciones user_can_* referencian esa tabla
-- y Postgres valida al crear funciones language sql.

-- ---------------------------------------------------------------------------
-- Tabla device_members (antes de user_can_access_device / user_can_edit_device)
-- ---------------------------------------------------------------------------

create table if not exists public.device_members (
  device_id uuid not null references public.devices (id) on delete cascade,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (device_id, member_user_id)
);

create index if not exists idx_device_members_member
  on public.device_members (member_user_id);

comment on table public.device_members is 'Usuarios invitados a un equipo: viewer solo lectura, editor puede umbrales/ficha/marcadores.';

alter table public.device_members enable row level security;

drop policy if exists "dm_select_owner_member_admin" on public.device_members;
create policy "dm_select_owner_member_admin"
  on public.device_members for select
  using (
    public.is_app_admin()
    or member_user_id = auth.uid()
    or exists (
      select 1 from public.devices d
      where d.id = device_members.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "dm_insert_owner_admin" on public.device_members;
create policy "dm_insert_owner_admin"
  on public.device_members for insert
  with check (
    public.is_app_admin()
    or exists (
      select 1 from public.devices d
      where d.id = device_members.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "dm_update_owner_admin" on public.device_members;
create policy "dm_update_owner_admin"
  on public.device_members for update
  using (
    public.is_app_admin()
    or exists (
      select 1 from public.devices d
      where d.id = device_members.device_id and d.owner_user_id = auth.uid()
    )
  )
  with check (
    public.is_app_admin()
    or exists (
      select 1 from public.devices d
      where d.id = device_members.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "dm_delete_owner_admin_or_self" on public.device_members;
create policy "dm_delete_owner_admin_or_self"
  on public.device_members for delete
  using (
    public.is_app_admin()
    or member_user_id = auth.uid()
    or exists (
      select 1 from public.devices d
      where d.id = device_members.device_id and d.owner_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Funciones de acceso (SECURITY DEFINER: solo consulta tablas públicas + auth.uid())
-- ---------------------------------------------------------------------------

create or replace function public.user_can_access_device(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.devices d
      where d.id = p_device_id and d.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.device_members m
      where m.device_id = p_device_id and m.member_user_id = auth.uid()
    );
$$;

grant execute on function public.user_can_access_device(uuid) to authenticated;

create or replace function public.user_can_edit_device(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_app_admin()
    or exists (
      select 1 from public.devices d
      where d.id = p_device_id and d.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.device_members m
      where m.device_id = p_device_id
        and m.member_user_id = auth.uid()
        and m.role = 'editor'
    );
$$;

grant execute on function public.user_can_edit_device(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Marcadores de gráfico
-- ---------------------------------------------------------------------------

create table if not exists public.device_chart_markers (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  marked_at timestamptz not null,
  label text not null,
  note text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists idx_device_chart_markers_device_time
  on public.device_chart_markers (device_id, marked_at desc);

comment on table public.device_chart_markers is 'Marcas verticales en el análisis de gráfico (visitas, fallas, etc.).';

alter table public.device_chart_markers enable row level security;

drop policy if exists "dcm_select_access" on public.device_chart_markers;
create policy "dcm_select_access"
  on public.device_chart_markers for select
  using (public.user_can_access_device(device_id));

drop policy if exists "dcm_insert_editor" on public.device_chart_markers;
create policy "dcm_insert_editor"
  on public.device_chart_markers for insert
  with check (
    public.user_can_edit_device(device_id) and created_by = auth.uid()
  );

drop policy if exists "dcm_update_editor" on public.device_chart_markers;
create policy "dcm_update_editor"
  on public.device_chart_markers for update
  using (public.user_can_edit_device(device_id))
  with check (public.user_can_edit_device(device_id));

drop policy if exists "dcm_delete_editor" on public.device_chart_markers;
create policy "dcm_delete_editor"
  on public.device_chart_markers for delete
  using (public.user_can_edit_device(device_id));

-- ---------------------------------------------------------------------------
-- RLS: dispositivos / lecturas / umbrales — lectura para miembros
-- ---------------------------------------------------------------------------

drop policy if exists "member_select_devices" on public.devices;
create policy "member_select_devices"
  on public.devices for select
  using (
    exists (
      select 1 from public.device_members m
      where m.device_id = devices.id and m.member_user_id = auth.uid()
    )
  );

drop policy if exists "member_select_readings" on public.device_readings;
create policy "member_select_readings"
  on public.device_readings for select
  using (public.user_can_access_device(device_id));

drop policy if exists "member_select_thresholds" on public.device_thresholds;
create policy "member_select_thresholds"
  on public.device_thresholds for select
  using (public.user_can_access_device(device_id));

drop policy if exists "editor_update_thresholds" on public.device_thresholds;
create policy "editor_update_thresholds"
  on public.device_thresholds for update
  using (public.user_can_edit_device(device_id))
  with check (public.user_can_edit_device(device_id));

-- ---------------------------------------------------------------------------
-- Ficha técnica: miembros lectura; editor = mismo poder que dueño en estas tablas
-- ---------------------------------------------------------------------------

drop policy if exists "member_select_equipment_fichas" on public.device_equipment_fichas;
create policy "member_select_equipment_fichas"
  on public.device_equipment_fichas for select
  using (public.user_can_access_device(device_id));

drop policy if exists "editor_manage_equipment_fichas" on public.device_equipment_fichas;
create policy "editor_manage_equipment_fichas"
  on public.device_equipment_fichas for all
  using (public.user_can_edit_device(device_id))
  with check (public.user_can_edit_device(device_id));

drop policy if exists "member_select_equipment_log" on public.device_equipment_log;
create policy "member_select_equipment_log"
  on public.device_equipment_log for select
  using (public.user_can_access_device(device_id));

drop policy if exists "editor_manage_equipment_log" on public.device_equipment_log;
create policy "editor_manage_equipment_log"
  on public.device_equipment_log for all
  using (public.user_can_edit_device(device_id))
  with check (public.user_can_edit_device(device_id));

drop policy if exists "member_select_equipment_photos" on public.device_equipment_photos;
create policy "member_select_equipment_photos"
  on public.device_equipment_photos for select
  using (public.user_can_access_device(device_id));

drop policy if exists "editor_manage_equipment_photos" on public.device_equipment_photos;
create policy "editor_manage_equipment_photos"
  on public.device_equipment_photos for all
  using (public.user_can_edit_device(device_id))
  with check (public.user_can_edit_device(device_id));

-- ---------------------------------------------------------------------------
-- RPC gráfico: dueño, miembro o admin
-- ---------------------------------------------------------------------------

drop function if exists public.get_device_readings_chart(uuid, timestamptz, timestamptz) cascade;

create function public.get_device_readings_chart(
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  read_at timestamptz,
  temp1_c double precision,
  temp2_c double precision,
  temp3_c double precision,
  current_a double precision,
  power_w double precision,
  temp1_raw_c double precision,
  temp2_raw_c double precision,
  temp3_raw_c double precision,
  current_a_raw double precision,
  power_w_raw double precision
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  span interval;
begin
  if p_from > p_to then
    return;
  end if;

  if not exists (select 1 from public.devices d where d.id = p_device_id) then
    return;
  end if;

  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if not public.user_can_access_device(p_device_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  span := p_to - p_from;

  if span <= interval '4 days' then
    return query
      select dr.created_at,
             dr.temp1_c,
             dr.temp2_c,
             dr.temp3_c,
             dr.current_a,
             dr.power_w,
             dr.temp1_raw_c,
             dr.temp2_raw_c,
             dr.temp3_raw_c,
             dr.current_a_raw,
             dr.power_w_raw
      from public.device_readings dr
      where dr.device_id = p_device_id
        and dr.created_at >= p_from
        and dr.created_at <= p_to
      order by dr.created_at asc
      limit 100000;
    return;
  end if;

  if span <= interval '400 days' then
    return query
      select date_trunc('hour', dr.created_at) as read_at,
             avg(dr.temp1_c)::double precision,
             avg(dr.temp2_c)::double precision,
             avg(dr.temp3_c)::double precision,
             avg(dr.current_a)::double precision,
             avg(dr.power_w)::double precision,
             avg(dr.temp1_raw_c)::double precision,
             avg(dr.temp2_raw_c)::double precision,
             avg(dr.temp3_raw_c)::double precision,
             avg(dr.current_a_raw)::double precision,
             avg(dr.power_w_raw)::double precision
      from public.device_readings dr
      where dr.device_id = p_device_id
        and dr.created_at >= p_from
        and dr.created_at <= p_to
      group by 1
      order by 1 asc;
    return;
  end if;

  return query
    select date_trunc('day', dr.created_at) as read_at,
           avg(dr.temp1_c)::double precision,
           avg(dr.temp2_c)::double precision,
           avg(dr.temp3_c)::double precision,
           avg(dr.current_a)::double precision,
           avg(dr.power_w)::double precision,
           avg(dr.temp1_raw_c)::double precision,
           avg(dr.temp2_raw_c)::double precision,
           avg(dr.temp3_raw_c)::double precision,
           avg(dr.current_a_raw)::double precision,
           avg(dr.power_w_raw)::double precision
    from public.device_readings dr
    where dr.device_id = p_device_id
      and dr.created_at >= p_from
      and dr.created_at <= p_to
    group by 1
    order by 1 asc;
end;
$$;

grant execute on function public.get_device_readings_chart(uuid, timestamptz, timestamptz) to authenticated;

revoke execute on function public.get_device_readings_chart(uuid, timestamptz, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- Invitar por email (busca auth.users; solo dueño o admin)
-- ---------------------------------------------------------------------------

create or replace function public.add_device_member_by_email(
  p_device_id uuid,
  p_email text,
  p_role text
)
returns void
language plpgsql
security definer
-- Un solo SET: "search_path TO public, auth" (no usar "= public, auth": la coma separa otro parámetro SET y rompe el parseo).
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

  -- Asignación por subconsulta escalar (evita que un editor SQL parta "INTO var" en otra sentencia).
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

  insert into public.device_members (device_id, member_user_id, role, invited_by)
  values (p_device_id, member_uid, p_role, auth.uid())
  on conflict (device_id, member_user_id) do update
    set role = excluded.role,
        invited_by = excluded.invited_by;
end;
$$;

grant execute on function public.add_device_member_by_email(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
