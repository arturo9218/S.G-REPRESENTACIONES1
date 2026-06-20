-- Estado de push en combistatos (usa AR24–AR29 de params; ya no hace falta combistato_thresholds).
-- Ejecutar después de 062 si lo aplicaste (migra marcas y opcionalmente borra la tabla vieja).

alter table public.combistatos
  add column if not exists last_push_temp_breach_at timestamptz;

alter table public.combistatos
  add column if not exists last_push_offline_at timestamptz;

alter table public.combistatos
  add column if not exists temp_breach_episode_started_at timestamptz;

comment on column public.combistatos.last_push_temp_breach_at is
  'Último push FCM por alarma térmica (AR24–AR26 en params).';

comment on column public.combistatos.last_push_offline_at is
  'Último push FCM por sin lecturas (check-offline-push).';

comment on column public.combistatos.temp_breach_episode_started_at is
  'Inicio del episodio de temperatura fuera de umbral (retardo AR26).';

-- Migrar filas de combistato_thresholds si existía.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'combistato_thresholds'
  ) then
    update public.combistatos c
    set
      last_push_temp_breach_at = t.last_push_temp_breach_at,
      last_push_offline_at = t.last_push_offline_at,
      temp_breach_episode_started_at = t.temp_breach_episode_started_at
    from public.combistato_thresholds t
    where t.combistato_id = c.id;
    drop table public.combistato_thresholds;
  end if;
end $$;

notify pgrst, 'reload schema';
