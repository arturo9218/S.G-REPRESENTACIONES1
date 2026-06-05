-- Presupuestos por usuario (AR Monitoreo). Ejecutar en Supabase SQL Editor.

create table if not exists public.presupuestos (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  reference_code text,
  client_name text not null default '',
  client_phone text,
  client_email text,
  site_address text,
  work_description text,
  notes text,
  items jsonb not null default '[]'::jsonb,
  currency text not null default 'ARS',
  tax_percent numeric not null default 21,
  discount_percent numeric not null default 0,
  status text not null default 'borrador',
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint presupuestos_status_check check (
    status in ('borrador', 'enviado', 'aceptado', 'rechazado')
  )
);

comment on table public.presupuestos is
  'Presupuestos de obra / servicio frigorífico creados por cada usuario de AR Monitoreo.';

create index if not exists idx_presupuestos_owner_updated
  on public.presupuestos (owner_user_id, updated_at desc);

alter table public.presupuestos enable row level security;

drop policy if exists "presupuesto_select_own_admin" on public.presupuestos;
create policy "presupuesto_select_own_admin"
  on public.presupuestos for select
  to authenticated
  using (owner_user_id = auth.uid() or public.is_app_admin());

drop policy if exists "presupuesto_insert_own" on public.presupuestos;
create policy "presupuesto_insert_own"
  on public.presupuestos for insert
  to authenticated
  with check (owner_user_id = auth.uid());

drop policy if exists "presupuesto_update_own_admin" on public.presupuestos;
create policy "presupuesto_update_own_admin"
  on public.presupuestos for update
  to authenticated
  using (owner_user_id = auth.uid() or public.is_app_admin())
  with check (owner_user_id = auth.uid() or public.is_app_admin());

drop policy if exists "presupuesto_delete_own_admin" on public.presupuestos;
create policy "presupuesto_delete_own_admin"
  on public.presupuestos for delete
  to authenticated
  using (owner_user_id = auth.uid() or public.is_app_admin());

create or replace function public.presupuestos_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists presupuestos_touch_updated_at_trg on public.presupuestos;
create trigger presupuestos_touch_updated_at_trg
  before update on public.presupuestos
  for each row
  execute function public.presupuestos_touch_updated_at();
