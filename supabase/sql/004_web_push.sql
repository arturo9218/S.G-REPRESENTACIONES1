-- Web Push: suscripciones por usuario y cooldowns para no spamear.
-- Tras ejecutar: Dashboard → Project Settings → Edge Functions → Secrets:
--   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ej. mailto:tu@email.com)
--   ALERT_CRON_SECRET (string larga; misma valor en el cron que llama a check-offline-push)

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_unique unique (endpoint)
);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "user owns push subscriptions" on public.push_subscriptions;
create policy "user owns push subscriptions"
  on public.push_subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Cooldowns (evita una notificación por cada lectura del ESP)
alter table public.device_thresholds
  add column if not exists last_push_temp_breach_at timestamptz;

alter table public.device_thresholds
  add column if not exists last_push_offline_at timestamptz;

-- Solo la service_role (Edge Functions) debe poder leer agregados para el chequeo offline.
create or replace function public.internal_last_reading_per_device ()
returns table (
  device_id uuid,
  last_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select dr.device_id, max(dr.created_at)::timestamptz
  from public.device_readings dr
  group by dr.device_id;
$$;

revoke all on function public.internal_last_reading_per_device () from public;
grant execute on function public.internal_last_reading_per_device () to service_role;

notify pgrst, 'reload schema';
