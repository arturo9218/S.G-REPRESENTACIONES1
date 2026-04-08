/*
  Tensión nominal de línea (V) por equipo: para estimar energía P = V·I cuando solo hay corriente,
  y para la función de consumo diario (kWh).

  Requisitos: 001 (device_thresholds), 011/012 (is_app_admin) para el mismo patrón de autorización
  que get_device_readings_chart (016).

  En Supabase: SQL Editor → pegar y ejecutar todo el archivo.
*/

alter table public.device_thresholds
  add column if not exists nominal_voltage_v double precision;

update public.device_thresholds
set nominal_voltage_v = 220
where nominal_voltage_v is null;

alter table public.device_thresholds
  alter column nominal_voltage_v set default 220;

alter table public.device_thresholds
  alter column nominal_voltage_v set not null;

-- ---------------------------------------------------------------------------
-- Energía (kWh) en [p_from, p_to] por integración trapezoidal entre lecturas.
-- Potencia instantánea: coalesce(power_w, current_a * nominal_voltage_v del equipo).
-- ---------------------------------------------------------------------------

drop function if exists public.get_device_energy_kwh(uuid, timestamptz, timestamptz) cascade;

create function public.get_device_energy_kwh(
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns double precision
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_n double precision;
  acc double precision := 0;
  rec record;
  prev_ts timestamptz;
  prev_p double precision;
  first_row boolean := true;
begin
  if p_from >= p_to then
    return 0;
  end if;

  select d.owner_user_id into v_owner
  from public.devices d
  where d.id = p_device_id;

  if v_owner is null then
    return 0;
  end if;

  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if auth.uid() <> v_owner and not public.is_app_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(dt.nominal_voltage_v, 220.0) into v_n
  from public.device_thresholds dt
  where dt.device_id = p_device_id
  limit 1;

  if v_n is null or v_n <= 0 then
    v_n := 220.0;
  end if;

  for rec in
    select
      dr.created_at as ts,
      coalesce(dr.power_w, dr.current_a * v_n) as p
    from public.device_readings dr
    where dr.device_id = p_device_id
      and dr.created_at >= p_from
      and dr.created_at <= p_to
    order by dr.created_at asc
  loop
    if rec.p is null then
      continue;
    end if;
    if first_row then
      prev_ts := rec.ts;
      prev_p := rec.p;
      first_row := false;
      continue;
    end if;
    acc := acc + ((prev_p + rec.p) / 2.0) * extract(epoch from (rec.ts - prev_ts));
    prev_ts := rec.ts;
    prev_p := rec.p;
  end loop;

  return (acc / 3600000.0);
end;
$$;

grant execute on function public.get_device_energy_kwh(uuid, timestamptz, timestamptz) to authenticated;

revoke execute on function public.get_device_energy_kwh(uuid, timestamptz, timestamptz) from public;

notify pgrst, 'reload schema';
