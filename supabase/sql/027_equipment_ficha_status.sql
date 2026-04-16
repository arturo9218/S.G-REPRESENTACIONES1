-- Estado de la ficha técnica (borrador / operativa / fuera de servicio).
-- Ejecutar después de 022 y 026.

alter table public.device_equipment_fichas
  add column if not exists status text default 'draft';

comment on column public.device_equipment_fichas.status is 'draft | active | out_of_service';

update public.device_equipment_fichas
set status = 'active'
where status is null;

notify pgrst, 'reload schema';

