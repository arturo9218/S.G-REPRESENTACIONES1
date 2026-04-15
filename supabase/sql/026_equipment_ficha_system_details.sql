-- Fase 1: detalle extendido del sistema frigorífico en fichas técnicas.
-- Ejecutar después de 022/023.

alter table public.device_equipment_fichas
  add column if not exists suction_line_diameter text;

alter table public.device_equipment_fichas
  add column if not exists liquid_line_diameter text;

alter table public.device_equipment_fichas
  add column if not exists line_insulation_status text;

alter table public.device_equipment_fichas
  add column if not exists high_pressure_switch text;

alter table public.device_equipment_fichas
  add column if not exists low_pressure_switch text;

alter table public.device_equipment_fichas
  add column if not exists controller_model text;

alter table public.device_equipment_fichas
  add column if not exists contactor_status text;

alter table public.device_equipment_fichas
  add column if not exists suction_pressure_bar double precision;

alter table public.device_equipment_fichas
  add column if not exists discharge_pressure_bar double precision;

alter table public.device_equipment_fichas
  add column if not exists superheat_c double precision;

alter table public.device_equipment_fichas
  add column if not exists subcooling_c double precision;

alter table public.device_equipment_fichas
  add column if not exists compressor_current_a double precision;

comment on column public.device_equipment_fichas.suction_line_diameter is 'Línea de succión (medida / diámetro).';
comment on column public.device_equipment_fichas.liquid_line_diameter is 'Línea de líquido (medida / diámetro).';
comment on column public.device_equipment_fichas.line_insulation_status is 'Estado de aislación de líneas.';
comment on column public.device_equipment_fichas.high_pressure_switch is 'Estado/ajuste del presostato de alta.';
comment on column public.device_equipment_fichas.low_pressure_switch is 'Estado/ajuste del presostato de baja.';
comment on column public.device_equipment_fichas.controller_model is 'Controlador/termostato (marca/modelo).';
comment on column public.device_equipment_fichas.contactor_status is 'Contactor/protecciones (estado/observación).';
comment on column public.device_equipment_fichas.suction_pressure_bar is 'Presión de succión en bar.';
comment on column public.device_equipment_fichas.discharge_pressure_bar is 'Presión de descarga en bar.';
comment on column public.device_equipment_fichas.superheat_c is 'Sobrecalentamiento en °C.';
comment on column public.device_equipment_fichas.subcooling_c is 'Subenfriamiento en °C.';
comment on column public.device_equipment_fichas.compressor_current_a is 'Corriente de compresor en A.';

notify pgrst, 'reload schema';
