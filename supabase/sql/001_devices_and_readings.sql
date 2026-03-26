-- SG Monitoreo: esquema para ESP8266 multi-sensor
-- Ejecutar en Supabase SQL Editor

create extension if not exists pgcrypto;

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  module_id text not null unique,
  name text not null,
  location text,
  device_token_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.device_readings (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.devices(id) on delete cascade,
  created_at timestamptz not null default now(),
  temp1_c double precision not null,
  temp2_c double precision,
  temp3_c double precision,
  power_w double precision,
  press1_bar double precision,
  press2_bar double precision
);

create index if not exists idx_device_readings_device_created
  on public.device_readings(device_id, created_at desc);

create table if not exists public.device_thresholds (
  device_id uuid primary key references public.devices(id) on delete cascade,
  notifications_enabled boolean not null default true,
  temp1_min_c double precision,
  temp1_max_c double precision,
  temp2_min_c double precision,
  temp2_max_c double precision,
  temp3_min_c double precision,
  temp3_max_c double precision,
  power_max_w double precision,
  press1_min_bar double precision,
  press1_max_bar double precision,
  press2_min_bar double precision,
  press2_max_bar double precision,
  updated_at timestamptz not null default now()
);

alter table public.devices enable row level security;
alter table public.device_readings enable row level security;
alter table public.device_thresholds enable row level security;

drop policy if exists "owner reads devices" on public.devices;
create policy "owner reads devices"
  on public.devices for select
  using (auth.uid() = owner_user_id);

drop policy if exists "owner manages devices" on public.devices;
create policy "owner manages devices"
  on public.devices for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "owner reads readings" on public.device_readings;
create policy "owner reads readings"
  on public.device_readings for select
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_readings.device_id
        and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner reads thresholds" on public.device_thresholds;
create policy "owner reads thresholds"
  on public.device_thresholds for select
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_thresholds.device_id
        and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner manages thresholds" on public.device_thresholds;
create policy "owner manages thresholds"
  on public.device_thresholds for all
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_thresholds.device_id
        and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_thresholds.device_id
        and d.owner_user_id = auth.uid()
    )
  );
