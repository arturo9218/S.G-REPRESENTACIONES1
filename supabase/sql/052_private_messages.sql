-- Mensajes privados entre dos usuarios (AR Monitoreo).
-- Ejecutar después de 049_community_messages.sql.

create table if not exists public.private_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  sender_email text not null default '',
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint private_messages_no_self check (sender_id <> recipient_id)
);

comment on table public.private_messages is
  'Mensajes directos 1 a 1; solo participan emisor y destinatario.';

create index if not exists idx_private_messages_pair_time
  on public.private_messages (sender_id, recipient_id, created_at desc);

create index if not exists idx_private_messages_recipient_time
  on public.private_messages (recipient_id, created_at desc);

alter table public.private_messages enable row level security;

drop policy if exists "private_select_participant" on public.private_messages;
create policy "private_select_participant"
  on public.private_messages for select
  to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists "private_insert_sender" on public.private_messages;
create policy "private_insert_sender"
  on public.private_messages for insert
  to authenticated
  with check (sender_id = auth.uid() and recipient_id <> auth.uid());

drop policy if exists "private_delete_sender" on public.private_messages;
create policy "private_delete_sender"
  on public.private_messages for delete
  to authenticated
  using (sender_id = auth.uid() or public.is_app_admin());

create or replace function public.private_messages_fill_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sender_email is null or trim(new.sender_email) = '' then
    new.sender_email := coalesce(
      (select email from auth.users where id = new.sender_id limit 1),
      'usuario'
    );
  end if;
  new.sender_email := lower(trim(new.sender_email));
  new.body := trim(new.body);
  return new;
end;
$$;

drop trigger if exists private_messages_fill_email_trg on public.private_messages;
create trigger private_messages_fill_email_trg
  before insert on public.private_messages
  for each row
  execute function public.private_messages_fill_email();

-- list_chat_contacts() → ejecutar 055_chat_contacts_unread.sql después de 054
-- (evita conflicto de tipos si se re-ejecuta este archivo).

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'private_messages'
  ) then
    alter publication supabase_realtime add table public.private_messages;
  end if;
end $$;
