/*
  IMPORTANTE — no usar solo este archivo en producción para “varios administradores”:

  - La función is_app_admin() definida abajo compara contra UN email fijo en el SQL.
  - El panel “Administradores” guarda en public.admin_emails (012_admin_emails.sql).
    Si is_app_admin() sigue siendo la versión de 011, los nuevos admins en la tabla
    NO tendrán permisos de admin en la base.

  Orden recomendado en un proyecto nuevo:
  1) 011_admin_app.sql  → políticas RLS para admin + primera versión de is_app_admin
  2) 012_admin_emails.sql → tabla admin_emails + is_app_admin() basada en esa tabla
  3) 020_is_app_admin_auth_users_email.sql → is_app_admin() usando email de auth.users
     (más fiable que solo auth.jwt() ->> 'email')

  Si ya ejecutaste 011 y 012, al menos corré 020 si los admins agregados en el panel
  no ven todos los equipos.
*/

-- Permite leer/modificar todos los dispositivos, lecturas y umbrales si el JWT
-- coincide con el email de administrador (sin guardar contraseñas en la DB).

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select lower(coalesce((auth.jwt() ->> 'email')::text, '')) = lower('arturoalmeida9218@gmail.com');
$$;

grant execute on function public.is_app_admin() to authenticated;

-- Dispositivos: admin ve y gestiona todo (además de las políticas por owner).
drop policy if exists "admin_select_devices" on public.devices;
create policy "admin_select_devices"
  on public.devices for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_devices" on public.devices;
create policy "admin_manage_devices"
  on public.devices for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- Lecturas
drop policy if exists "admin_select_readings" on public.device_readings;
create policy "admin_select_readings"
  on public.device_readings for select
  using (public.is_app_admin());

-- Umbrales
drop policy if exists "admin_select_thresholds" on public.device_thresholds;
create policy "admin_select_thresholds"
  on public.device_thresholds for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_thresholds" on public.device_thresholds;
create policy "admin_manage_thresholds"
  on public.device_thresholds for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- RPC gráfico: admin o dueño. Misma firma de retorno que 005_current_a.sql (read_at, temp1, temp2, current_a).
-- Hay que DROP si antes existía otra variante (3 columnas vs 4); Postgres no permite cambiar el tipo de retorno con CREATE OR REPLACE.
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
  current_a double precision
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  span interval;
begin
  if p_from > p_to then
    return;
  end if;

  select d.owner_user_id into v_owner
  from public.devices d
  where d.id = p_device_id;

  if v_owner is null then
    return;
  end if;

  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if auth.uid() <> v_owner and not public.is_app_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  span := p_to - p_from;

  if span <= interval '4 days' then
    return query
      select dr.created_at,
             dr.temp1_c,
             dr.temp2_c,
             dr.current_a
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
             avg(dr.current_a)::double precision
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
           avg(dr.current_a)::double precision
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

notify pgrst, 'reload schema';
-- Políticas de administrador (is_app_admin). Tras 012_admin_emails.sql la función usa la tabla admin_emails.
-- Ejecutar en Supabase SQL Editor después de los scripts anteriores.
--
