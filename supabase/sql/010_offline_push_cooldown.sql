-- Retardo independiente para push/pitido de “dispositivo desconectado” (ms).
-- Si quedó null en filas viejas, copia el retardo de temperatura.

alter table public.device_thresholds
  add column if not exists offline_push_cooldown_ms integer;

update public.device_thresholds
set offline_push_cooldown_ms = temp_push_cooldown_ms
where offline_push_cooldown_ms is null
  and temp_push_cooldown_ms is not null
  and temp_push_cooldown_ms > 0;

update public.device_thresholds
set offline_push_cooldown_ms = 15 * 60 * 1000
where offline_push_cooldown_ms is null or offline_push_cooldown_ms <= 0;

notify pgrst, 'reload schema';
