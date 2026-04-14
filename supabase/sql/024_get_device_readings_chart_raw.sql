-- Gráfico de análisis: devuelve también valores en crudo (temp*_raw_c, current_a_raw, power_w_raw)
-- para que el cliente pueda aplicar la corrección actual (offset) sin depender solo del valor ya corregido en ingesta.
-- Reemplaza get_device_readings_chart (misma firma de permisos que 016: dueño o is_app_admin).
-- Ejecutar en Supabase después de 011/016 y 020.

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

notify pgrst, 'reload schema';
