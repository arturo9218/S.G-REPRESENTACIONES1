-- PRO400: parámetros F01–F26 en `devices.params` (JSONB) para sync con ESP y app (AR01–AR26).

alter table public.devices
  add column if not exists params jsonb not null default '{}'::jsonb;

alter table public.devices
  add column if not exists equipment_kind text;

comment on column public.devices.params is 'PRO400: F01–F26; PRO300/PR500 usan otras tablas.';
comment on column public.devices.equipment_kind is 'pro400 | generic | null';
