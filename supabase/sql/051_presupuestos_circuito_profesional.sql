-- Extiende presupuestos: tipo de sistema, relevamiento de circuito y datos del técnico.
-- Ejecutar después de 050_presupuestos.sql.

alter table public.presupuestos
  add column if not exists system_type text,
  add column if not exists system_type_other text,
  add column if not exists refrigerant text,
  add column if not exists nominal_capacity text,
  add column if not exists company_name text,
  add column if not exists technician_name text,
  add column if not exists technician_phone text,
  add column if not exists technician_email text,
  add column if not exists technician_license text,
  add column if not exists logo_data_url text,
  add column if not exists circuit_survey jsonb not null default '{}'::jsonb;

comment on column public.presupuestos.system_type is
  'camara | heladera | central_frigorifica | chiller | banco_agua_helada | otro';
comment on column public.presupuestos.circuit_survey is
  'Relevamiento: evaporador, condensador/compresor, líneas y componentes con estado.';
