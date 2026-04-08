-- Ampliar historial de alarmas: consumo (power) y columnas opcionales.
-- Requiere 013_device_alarm_events.sql aplicado.

alter table public.device_alarm_events
  add column if not exists temp2_c double precision;

alter table public.device_alarm_events
  add column if not exists power_w double precision;

alter table public.device_thresholds
  add column if not exists last_push_power_breach_at timestamptz;

alter table public.device_alarm_events
  drop constraint if exists device_alarm_events_kind_check;

alter table public.device_alarm_events
  add constraint device_alarm_events_kind_check
  check (kind in ('temp_breach', 'offline', 'power_breach'));

comment on column public.device_alarm_events.temp2_c is 'Temperatura sensor 2 al disparar (si aplica)';
comment on column public.device_alarm_events.power_w is 'Potencia W al disparar consumo (si aplica)';
comment on column public.device_thresholds.last_push_power_breach_at is 'Último intento de aviso por consumo (cooldown)';

notify pgrst, 'reload schema';
