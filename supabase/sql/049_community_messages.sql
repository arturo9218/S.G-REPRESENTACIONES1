-- Sala de conversación global: usuarios autenticados de AR Monitoreo.
-- Ejecutar en Supabase SQL Editor. Luego habilitar Realtime (bloque al final).

create table if not exists public.community_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  author_email text not null default '',
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

comment on table public.community_messages is
  'Mensajes de la sala comunitaria AR Monitoreo (todos los usuarios registrados).';

create index if not exists idx_community_messages_created
  on public.community_messages (created_at desc);

alter table public.community_messages enable row level security;

drop policy if exists "community_select_authenticated" on public.community_messages;
create policy "community_select_authenticated"
  on public.community_messages for select
  to authenticated
  using (true);

drop policy if exists "community_insert_own" on public.community_messages;
create policy "community_insert_own"
  on public.community_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "community_delete_own" on public.community_messages;
create policy "community_delete_own"
  on public.community_messages for delete
  to authenticated
  using (auth.uid() = user_id or public.is_app_admin());

create or replace function public.community_messages_fill_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_email is null or trim(new.author_email) = '' then
    new.author_email := coalesce(
      (select email from auth.users where id = new.user_id limit 1),
      'usuario'
    );
  end if;
  new.body := trim(new.body);
  return new;
end;
$$;

drop trigger if exists community_messages_fill_email_trg on public.community_messages;
create trigger community_messages_fill_email_trg
  before insert on public.community_messages
  for each row
  execute function public.community_messages_fill_email();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_messages'
  ) then
    alter publication supabase_realtime add table public.community_messages;
  end if;
end $$;
