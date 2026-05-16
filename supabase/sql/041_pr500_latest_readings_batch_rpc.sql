-- Última lectura por PR500 en una sola llamada (panel: de N consultas → 1).
-- Ejecutar en Supabase SQL Editor después de 037–039.

create or replace function public.get_pr500_latest_readings(p_pr500_ids uuid[])
returns table (
  pr500_id uuid,
  created_at timestamptz,
  pressure_bar double precision,
  comp1_on boolean,
  comp2_on boolean,
  comp3_on boolean,
  alarm_on boolean,
  comp1_run_ms bigint,
  comp2_run_ms bigint,
  comp3_run_ms bigint,
  temp_suction_c double precision,
  superheat_c double precision,
  superheat_ok boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (r.pr500_id)
    r.pr500_id,
    r.created_at,
    r.pressure_bar,
    r.comp1_on,
    r.comp2_on,
    r.comp3_on,
    r.alarm_on,
    r.comp1_run_ms,
    r.comp2_run_ms,
    r.comp3_run_ms,
    r.temp_suction_c,
    r.superheat_c,
    r.superheat_ok
  from public.pr500_readings r
  inner join public.pr500_controllers p on p.id = r.pr500_id
  where cardinality(p_pr500_ids) > 0
    and r.pr500_id = any (p_pr500_ids)
    and (
      p.owner_user_id = auth.uid()
      or public.is_app_admin()
    )
  order by r.pr500_id, r.created_at desc;
$$;

revoke all on function public.get_pr500_latest_readings(uuid[]) from public;
grant execute on function public.get_pr500_latest_readings(uuid[]) to authenticated;

comment on function public.get_pr500_latest_readings(uuid[]) is
  'Panel PR500: última fila de pr500_readings por id (RLS vía dueño/admin).';

notify pgrst, 'reload schema';
