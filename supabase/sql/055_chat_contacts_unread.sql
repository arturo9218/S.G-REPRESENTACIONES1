-- Campana / contador de no leídos en la lista de contactos. Ejecutar después de 054.
-- Si falla "cannot change return type", este DROP recrea la función con unread_count.

drop function if exists public.list_chat_contacts();

create or replace function public.list_chat_contacts()
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
