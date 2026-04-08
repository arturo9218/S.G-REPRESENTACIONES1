-- Umbral de corriente (A RMS), no potencia (W). Requiere 013 (y opcional 014).

alter table public.device_thresholds
  add column if not exists current_max_a double precision;

alter table public.device_thresholds
  add column if not exists last_push_current_breach_at timestamptz;

alter table public.device_alarm_events
  add column if not exists current_a double precision;

alter table public.device_alarm_events
  drop constraint if exists device_alarm_events_kind_check;

update public.device_alarm_events
  set kind = 'current_breach'
  where kind = 'power_breach';

alter table public.device_alarm_events
  add constraint device_alarm_events_kind_check
  check (kind in ('temp_breach', 'offline', 'current_breach'));

comment on column public.device_thresholds.current_max_a is 'Corriente RMS máxima (A); superarla dispara alerta';
comment on column public.device_thresholds.last_push_current_breach_at is 'Último intento de aviso por corriente (cooldown)';
comment on column public.device_alarm_events.current_a is 'Corriente RMS (A) al disparar (si aplica)';

notify pgrst, 'reload schema';
