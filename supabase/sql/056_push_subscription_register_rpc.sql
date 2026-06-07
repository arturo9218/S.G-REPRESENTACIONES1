-- Un celular = un endpoint FCM por origen. Si otro usuario ya activó avisos en el mismo
-- dispositivo, el upsert directo falla por RLS (la fila pertenece al otro user_id).
-- Esta función reasigna el endpoint al usuario que inicia sesión ahora.

create or replace function public.register_push_subscription (
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(trim(p_endpoint), '') = '' then
    raise exception 'endpoint required';
  end if;

  delete from public.push_subscriptions
  where endpoint = trim(p_endpoint);

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, updated_at)
  values (uid, trim(p_endpoint), trim(p_p256dh), trim(p_auth), now());
end;
$$;

revoke all on function public.register_push_subscription (text, text, text) from public;
grant execute on function public.register_push_subscription (text, text, text) to authenticated;

notify pgrst, 'reload schema';
