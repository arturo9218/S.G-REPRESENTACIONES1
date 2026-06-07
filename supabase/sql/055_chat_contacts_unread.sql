-- Campana / contador de no leídos en la lista de contactos.
-- Ejecutar después de 052 y 054 (necesita private_messages.read_at).

-- Borra cualquier versión anterior de la función (2 o 3 columnas).
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'list_chat_contacts'
  loop
    execute format('drop function if exists %s cascade', fn);
  end loop;
end $$;

create function public.list_chat_contacts()
returns table (user_id uuid, email text, unread_count bigint)
language sql
security definer
stable
set search_path = public
as $$
  select
    u.id,
    lower(trim(u.email::text)),
    coalesce(
      (
        select count(*)::bigint
        from public.private_messages m
        where m.recipient_id = auth.uid()
          and m.sender_id = u.id
          and m.read_at is null
      ),
      0
    ) as unread_count
  from auth.users u
  where u.id is distinct from auth.uid()
    and u.email is not null
    and trim(u.email::text) <> ''
  order by unread_count desc, lower(trim(u.email::text));
$$;

revoke all on function public.list_chat_contacts() from public;
grant execute on function public.list_chat_contacts() to authenticated;
