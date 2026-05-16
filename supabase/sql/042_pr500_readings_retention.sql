-- Retención de historial PR500 (reduce tamaño de DB en plan Free).
-- Ejecutar en Supabase SQL Editor. Programar con pg_cron o ejecutar a mano cada mes.

create or replace function public.prune_pr500_readings_older_than(p_days integer default 90)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz;
  v_deleted bigint;
begin
  if auth.uid() is null or not public.is_app_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_days is null or p_days < 7 then
    raise exception 'p_days must be >= 7' using errcode = '22023';
  end if;

  v_cutoff := now() - make_interval(days => p_days);

  delete from public.pr500_readings r
  where r.created_at < v_cutoff;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_pr500_readings_older_than(integer) from public;
grant execute on function public.prune_pr500_readings_older_than(integer) to authenticated;

comment on function public.prune_pr500_readings_older_than(integer) is
  'Solo admin: borra lecturas PR500 más viejas que p_days (default 90).';

notify pgrst, 'reload schema';
