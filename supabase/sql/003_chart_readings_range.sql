-- Historial largo para gráficos: la app llama esta función con un rango [p_from, p_to].
-- <= 4 días: puntos crudos (máx. 100k; antes 20k cortaba el final del rango con muchas lecturas).
-- <= 400 días: promedio por hora.
-- > 400 días: promedio por día (adecuado para ~1 año o más).
-- Ejecutar en Supabase SQL Editor después de 001 y 002.
--
-- Si la app muestra error al cargar el gráfico:
-- 1) Copiá TODO este archivo y ejecutalo de una vez (Run).
-- 2) Esperá ~1 min o: Project Settings → API → pausar y reactivar el proyecto (refresca PostgREST).
-- 3) En la app, abrí la consola (F12): el mensaje de error ahora incluye el detalle de Supabase.
--
-- Si Postgres dice que no puede cambiar el tipo de retorno: otra variante de esta función ya existe
-- (p. ej. con columna current_a en 005/011). Hay que DROP antes de crear; CASCADE quita dependencias.
-- Si usás gráfico de corriente (A) en análisis, preferí FRONTEND/supabase/sql/011_admin_app.sql en lugar de este archivo.

drop function if exists public.get_device_readings_chart(uuid, timestamptz, timestamptz) cascade;

create or replace function public.get_device_readings_chart(
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  read_at timestamptz,
  temp1_c double precision,
  temp2_c double precision
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

  if auth.uid() is null or auth.uid() <> v_owner then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  span := p_to - p_from;

  if span <= interval '4 days' then
    return query
      select dr.created_at,
             dr.temp1_c,
             dr.temp2_c
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
             avg(dr.temp2_c)::double precision
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
           avg(dr.temp2_c)::double precision
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

-- Obliga a PostgREST a recargar funciones (evita "Could not find ... in the schema cache").
notify pgrst, 'reload schema';
