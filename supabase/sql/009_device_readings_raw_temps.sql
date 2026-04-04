-- Valores crudos del ESP por lectura (antes de sumar corrección en umbrales).
-- Permite que el panel muestre bruto + offset actual sin esperar un nuevo POST del equipo.

alter table public.device_readings
  add column if not exists temp1_raw_c double precision;

alter table public.device_readings
  add column if not exists temp2_raw_c double precision;

alter table public.device_readings
  add column if not exists temp3_raw_c double precision;

comment on column public.device_readings.temp1_raw_c is 'Temperatura bruta ESP canal 1 (antes de temp1_offset_c)';
comment on column public.device_readings.temp2_raw_c is 'Temperatura bruta ESP canal 2';
comment on column public.device_readings.temp3_raw_c is 'Temperatura bruta ESP canal 3';

notify pgrst, 'reload schema';

-- Opcional (solo si querés que filas viejas reaccionen al cambiar offset sin re-enviar el ESP):
-- update public.device_readings set temp1_raw_c = temp1_c where temp1_raw_c is null;
-- update public.device_readings set temp2_raw_c = temp2_c where temp2_raw_c is null and temp2_c is not null;
-- update public.device_readings set temp3_raw_c = temp3_c where temp3_raw_c is null and temp3_c is not null;
