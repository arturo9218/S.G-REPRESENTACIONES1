-- Tipo de expansión: capilar (medida) o válvula de expansión (marca y modelo).
-- Ejecutar después de 022.

alter table public.device_equipment_fichas
  add column if not exists expansion_type text;

alter table public.device_equipment_fichas
  add column if not exists expansion_capillary_measure text;

alter table public.device_equipment_fichas
  add column if not exists expansion_valve_brand text;

alter table public.device_equipment_fichas
  add column if not exists expansion_valve_model text;

comment on column public.device_equipment_fichas.expansion_type is 'capillary | valve';
comment on column public.device_equipment_fichas.expansion_capillary_measure is 'Medida del capilar si expansion_type = capillary';
comment on column public.device_equipment_fichas.expansion_valve_brand is 'Marca si expansion_type = valve';
comment on column public.device_equipment_fichas.expansion_valve_model is 'Modelo si expansion_type = valve';
