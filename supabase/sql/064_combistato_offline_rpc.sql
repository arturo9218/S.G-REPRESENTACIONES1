-- Última lectura por combistato (para check-offline-push).

create or replace function public.internal_last_reading_per_combistato ()
returns table (
  combistato_id uuid,
  last_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select cr.combistato_id, max(cr.created_at)::timestamptz
  from public.combistato_readings cr
  group by cr.combistato_id;
$$;

revoke all on function public.internal_last_reading_per_combistato () from public;
grant execute on function public.internal_last_reading_per_combistato () to service_role;

notify pgrst, 'reload schema';
