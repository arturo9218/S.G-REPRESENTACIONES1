-- Campos adicionales de línea de expansión / filtro / recibidor / solenoide (ficha técnica).
alter table public.device_equipment_fichas
  add column if not exists expansion_orifice_text text,
  add column if not exists expansion_filter_measure_text text,
  add column if not exists expansion_receiver_tube_text text,
  add column if not exists expansion_solenoid_valve_text text;

comment on column public.device_equipment_fichas.expansion_orifice_text is 'Orificio / cartucho válvula de expansión (dato libre)';
comment on column public.device_equipment_fichas.expansion_filter_measure_text is 'Medida filtro / secador de líquido u observación';
comment on column public.device_equipment_fichas.expansion_receiver_tube_text is 'Tubo recibidor (diámetro, longitud, etc.)';
comment on column public.device_equipment_fichas.expansion_solenoid_valve_text is 'Válvula solenoide (modelo, bobina, ubicación)';
