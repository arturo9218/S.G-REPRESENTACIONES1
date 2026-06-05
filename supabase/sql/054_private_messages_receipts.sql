-- Confirmación de entrega y lectura (mensajes privados). Ejecutar después de 052.

alter table public.private_messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

comment on column public.private_messages.delivered_at is
  'Cuando el destinatario recibió el mensaje en su dispositivo.';
comment on column public.private_messages.read_at is
  'Cuando el destinatario abrió la conversación y lo marcó como leído.';

create index if not exists idx_private_messages_unread
  on public.private_messages (recipient_id, sender_id)
  where read_at is null;

-- Marca como entregados los mensajes de un contacto hacia el usuario actual.
create or replace function public.mark_private_messages_delivered(p_sender_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is null then
    return 0;
  end if;
  update public.private_messages
  set delivered_at = now()
  where recipient_id = auth.uid()
    and sender_id = p_sender_id
    and delivered_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Marca como leídos al abrir el chat con ese contacto.
create or replace function public.mark_private_messages_read(p_sender_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is null then
    return 0;
  end if;
  update public.private_messages
  set
    delivered_at = coalesce(delivered_at, now()),
    read_at = now()
  where recipient_id = auth.uid()
    and sender_id = p_sender_id
    and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.mark_private_messages_delivered(uuid) from public;
revoke all on function public.mark_private_messages_read(uuid) from public;
grant execute on function public.mark_private_messages_delivered(uuid) to authenticated;
grant execute on function public.mark_private_messages_read(uuid) to authenticated;
