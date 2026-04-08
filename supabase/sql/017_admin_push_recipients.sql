/*
  Lista UUID de usuarios que son administradores (admin_emails + auth.users).
  Solo service_role (Edge Functions); no exponer a clientes anonimos.
  Requisito: 012_admin_emails.sql
*/

create or replace function public.get_admin_user_ids_for_push()
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from auth.users u
  inner join public.admin_emails e on lower(trim(u.email::text)) = lower(trim(e.email));
$$;

revoke all on function public.get_admin_user_ids_for_push() from public;
grant execute on function public.get_admin_user_ids_for_push() to service_role;

notify pgrst, 'reload schema';
