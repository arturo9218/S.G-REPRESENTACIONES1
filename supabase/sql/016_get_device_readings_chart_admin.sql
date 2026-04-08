/*
  Restaura get_device_readings_chart para que el administrador pueda ver graficos de cualquier dispositivo.

  Problema: 003 y 005 definen la funcion solo para el dueno (auth.uid() = owner). Si ejecutaste 005
  despues de 011, se sobrescribio la version con soporte admin: el RPC del analisis devuelve not authorized.

  Requisitos: 011_admin_app.sql y 012_admin_emails.sql (is_app_admin con tabla admin_emails).
  En Supabase: SQL Editor, pegar y ejecutar todo este archivo (NOTIFY recarga la API).
*/

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
