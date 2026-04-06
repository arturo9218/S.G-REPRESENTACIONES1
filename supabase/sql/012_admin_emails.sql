-- Lista de administradores; solo quien ya es admin puede agregar o quitar emails.
-- Requisito: haber ejecutado antes 011_admin_app.sql (políticas que usan is_app_admin).
--
-- Tras este script, is_app_admin() se basa en public.admin_emails (SECURITY DEFINER).

create table if not exists public.admin_emails (
  email text primary key
    constraint admin_emails_email_check check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now()
);

comment on table public.admin_emails is 'Emails con rol de administrador; solo admins pueden modificarla.';

create or replace function public.admin_emails_normalize()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

drop trigger if exists trg_admin_emails_normalize on public.admin_emails;
create trigger trg_admin_emails_normalize
  before insert or update on public.admin_emails
  for each row execute function public.admin_emails_normalize();

create or replace function public.prevent_remove_last_admin()
returns trigger
language plpgsql
as $$
begin
  if (select count(*)::int from public.admin_emails) <= 1 then
    raise exception 'Debe quedar al menos un administrador' using errcode = '23514';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_last_admin on public.admin_emails;
create trigger trg_prevent_last_admin
  before delete on public.admin_emails
  for each row execute function public.prevent_remove_last_admin();

insert into public.admin_emails (email) values ('arturoalmeida9218@gmail.com')
on conflict (email) do nothing;

-- Debe ir antes de RLS sobre admin_emails: lee la tabla con privilegios del owner (sin recursión).
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_emails e
    where lower(trim(e.email)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
  );
$$;

grant execute on function public.is_app_admin() to authenticated;

alter table public.admin_emails enable row level security;

drop policy if exists "admin_emails_select" on public.admin_emails;
create policy "admin_emails_select"
  on public.admin_emails for select
  using (public.is_app_admin());

drop policy if exists "admin_emails_insert" on public.admin_emails;
create policy "admin_emails_insert"
  on public.admin_emails for insert
  with check (public.is_app_admin());

drop policy if exists "admin_emails_delete" on public.admin_emails;
create policy "admin_emails_delete"
  on public.admin_emails for delete
  using (public.is_app_admin());

grant select, insert, delete on public.admin_emails to authenticated;

notify pgrst, 'reload schema';
