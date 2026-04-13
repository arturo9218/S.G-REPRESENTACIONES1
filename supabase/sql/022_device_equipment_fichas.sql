-- Varias fichas técnicas por dispositivo (ej. 2 cámaras) y campos detallados
-- condensador / evaporador (forzado, agua, estático, monofásico/trifásico).
-- Ejecutar después de 021. Migra datos de device_equipment_sheets → primera ficha.

-- ---------------------------------------------------------------------------
-- Tabla principal: N fichas por device
-- ---------------------------------------------------------------------------

create table if not exists public.device_equipment_fichas (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  sort_order integer not null default 0,
  label text not null default 'Instalación',

  compressor_text text,
  hp double precision,
  refrigerant text,

  condenser_cooling_type text,
  condenser_fan_count integer,
  condenser_blade_diameter_text text,
  condenser_fan_motor_phases text,
  condenser_fan_capacitor_uf text,
  condenser_notes text,

  evaporator_air_type text,
  evaporator_fan_count integer,
  evaporator_fan_motor_phases text,
  evaporator_fan_single_phase_detail text,
  evaporator_notes text,

  supply text,
  pump_down boolean not null default false,
  defrost text,
  chamber_type text,
  free_notes text,

  last_maintenance_at timestamptz,
  next_maintenance_at timestamptz,
  maintenance_interval_days integer,
  maintenance_notify_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists device_equipment_fichas_device_sort_idx
  on public.device_equipment_fichas (device_id, sort_order);

comment on table public.device_equipment_fichas is 'Ficha(s) técnica(s) por dispositivo; varias cámaras = varias filas.';
comment on column public.device_equipment_fichas.condenser_cooling_type is 'forced_air | water';
comment on column public.device_equipment_fichas.condenser_fan_motor_phases is 'three_phase | single_phase';
comment on column public.device_equipment_fichas.evaporator_air_type is 'forced | static';

-- ---------------------------------------------------------------------------
-- Migración desde device_equipment_sheets (si existe)
-- ---------------------------------------------------------------------------

insert into public.device_equipment_fichas (
  device_id,
  sort_order,
  label,
  compressor_text,
  hp,
  refrigerant,
  condenser_notes,
  evaporator_notes,
  supply,
  pump_down,
  defrost,
  chamber_type,
  free_notes,
  last_maintenance_at,
  next_maintenance_at,
  maintenance_interval_days,
  maintenance_notify_enabled,
  updated_at
)
select
  s.device_id,
  0,
  'Instalación principal',
  s.compressor_text,
  s.hp,
  s.refrigerant,
  s.condenser_text,
  s.evaporator_text,
  s.supply,
  s.pump_down,
  s.defrost,
  s.chamber_type,
  s.free_notes,
  s.last_maintenance_at,
  s.next_maintenance_at,
  s.maintenance_interval_days,
  s.maintenance_notify_enabled,
  s.updated_at
from public.device_equipment_sheets s
where not exists (
  select 1 from public.device_equipment_fichas f where f.device_id = s.device_id
);

-- ---------------------------------------------------------------------------
-- Bitácora y fotos: opcionalmente ligadas a una ficha
-- ---------------------------------------------------------------------------

alter table public.device_equipment_log
  add column if not exists ficha_id uuid references public.device_equipment_fichas (id) on delete set null;

create index if not exists device_equipment_log_ficha_idx
  on public.device_equipment_log (ficha_id);

alter table public.device_equipment_photos
  add column if not exists ficha_id uuid references public.device_equipment_fichas (id) on delete set null;

create index if not exists device_equipment_photos_ficha_idx
  on public.device_equipment_photos (ficha_id);

-- Asociar bitácora y fotos previas a la primera ficha del mismo equipo
update public.device_equipment_log l
set ficha_id = f.id
from public.device_equipment_fichas f
where f.device_id = l.device_id
  and f.sort_order = 0
  and l.ficha_id is null;

update public.device_equipment_photos p
set ficha_id = f.id
from public.device_equipment_fichas f
where f.device_id = p.device_id
  and f.sort_order = 0
  and p.ficha_id is null;

-- ---------------------------------------------------------------------------
-- RLS: fichas
-- ---------------------------------------------------------------------------

alter table public.device_equipment_fichas enable row level security;

drop policy if exists "owner_select_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_select_equipment_fichas"
  on public.device_equipment_fichas for select
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_fichas.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_insert_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_insert_equipment_fichas"
  on public.device_equipment_fichas for insert
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_fichas.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_update_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_update_equipment_fichas"
  on public.device_equipment_fichas for update
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_fichas.device_id and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_fichas.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "owner_delete_equipment_fichas" on public.device_equipment_fichas;
create policy "owner_delete_equipment_fichas"
  on public.device_equipment_fichas for delete
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_equipment_fichas.device_id and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "admin_select_equipment_fichas" on public.device_equipment_fichas;
create policy "admin_select_equipment_fichas"
  on public.device_equipment_fichas for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_equipment_fichas" on public.device_equipment_fichas;
create policy "admin_manage_equipment_fichas"
  on public.device_equipment_fichas for all
  using (public.is_app_admin())
  with check (public.is_app_admin());
