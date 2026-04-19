-- Diámetro de pala en forzadores del evaporador (ficha técnica).
-- Ejecutar en Supabase SQL Editor después de 022.

alter table public.device_equipment_fichas
  add column if not exists evaporator_fan_blade_diameter_text text;

comment on column public.device_equipment_fichas.evaporator_fan_blade_diameter_text is
  'Diámetro de pala / observación de forzadores del evaporador (ej. Ø 910 mm).';
