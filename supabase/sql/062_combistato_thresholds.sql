-- PRO300 (combistatos): umbrales de temperatura y cooldowns para push / pitido.
-- Ejecutar después de 033_combistatos.sql y 018_temp_breach_episode.sql (mismas columnas que device_thresholds).

create table if not exists public.combistato_thresholds (
  combistato_id uuid primary key references public.combistatos (id) on delete cascade,
  notifications_enabled boolean not null default true,
  temp1_min_c double precision,
  temp1_max_c double precision,
  temp2_min_c double precision,
  temp2_max_c double precision,
  temp1_offset_c double precision not null default 0,
  temp2_offset_c double precision not null default 0,
  temp_push_cooldown_ms integer not null default 900000,
  offline_push_cooldown_ms integer not null default 900000,
  last_push_temp_breach_at timestamptz,
  last_push_offline_at timestamptz,
  temp_breach_episode_started_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.combistato_thresholds is
  'Umbrales y retardo de notificaciones push para PRO300 (combistatos); evaluados en ingest-reading.';

alter table public.combistato_thresholds enable row level security;

drop policy if exists "combistato_thresholds_select" on public.combistato_thresholds;
create policy "combistato_thresholds_select"
  on public.combistato_thresholds for select
  using (
    exists (
      select 1 from public.combistatos c
      where c.id = combistato_thresholds.combistato_id
        and (c.owner_user_id = auth.uid() or public.is_app_admin())
    )
  );

drop policy if exists "combistato_thresholds_manage" on public.combistato_thresholds;
create policy "combistato_thresholds_manage"
  on public.combistato_thresholds for all
  using (
    exists (
      select 1 from public.combistatos c
      where c.id = combistato_thresholds.combistato_id
        and (c.owner_user_id = auth.uid() or public.is_app_admin())
    )
  )
  with check (
    exists (
      select 1 from public.combistatos c
      where c.id = combistato_thresholds.combistato_id
        and (c.owner_user_id = auth.uid() or public.is_app_admin())
    )
  );

-- Filas por defecto para combistatos existentes (sin umbrales hasta que el usuario configure).
insert into public.combistato_thresholds (combistato_id, notifications_enabled)
select c.id, true
from public.combistatos c
where not exists (
  select 1 from public.combistato_thresholds t where t.combistato_id = c.id
);

notify pgrst, 'reload schema';
