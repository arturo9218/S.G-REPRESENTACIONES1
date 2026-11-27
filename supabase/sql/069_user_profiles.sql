-- Perfil de cuenta: cliente | tecnico (separado de permisos por equipo).
-- Ejecutar en Supabase SQL Editor. El registro envía account_role en user_metadata.

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  account_role text not null default 'cliente' check (account_role in ('cliente', 'tecnico')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_select_own on public.user_profiles;
create policy user_profiles_select_own on public.user_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_app_admin());

drop policy if exists user_profiles_update_own on public.user_profiles;
create policy user_profiles_update_own on public.user_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, update on public.user_profiles to authenticated;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  role text := coalesce(new.raw_user_meta_data->>'account_role', 'cliente');
begin
  if role not in ('cliente', 'tecnico') then
    role := 'cliente';
  end if;
  insert into public.user_profiles (user_id, account_role)
  values (new.id, role)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.handle_new_user_profile();

-- Perfiles para usuarios ya existentes (default cliente).
insert into public.user_profiles (user_id, account_role)
select u.id, 'cliente'
from auth.users u
where not exists (select 1 from public.user_profiles p where p.user_id = u.id)
on conflict (user_id) do nothing;
