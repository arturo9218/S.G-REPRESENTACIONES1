-- Retardo configurable para alarmas push de temperatura por dispositivo.
-- Valor en milisegundos (ej. 25 min = 1500000).

alter table public.device_thresholds
  add column if not exists temp_push_cooldown_ms integer;

update public.device_thresholds
set temp_push_cooldown_ms = 15 * 60 * 1000
where temp_push_cooldown_ms is null or temp_push_cooldown_ms <= 0;

notify pgrst, 'reload schema';
