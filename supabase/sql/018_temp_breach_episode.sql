/*
  Inicio del episodio de alarma de temperatura (primer momento en rango fuera de umbral).
  ingest-reading: primer push tras temp_push_cooldown_ms; repetición cada 1 min mientras siga el fallo;
  al volver a rango se limpia y el próximo episodio vuelve a usar el retardo configurado.
*/

alter table public.device_thresholds
  add column if not exists temp_breach_episode_started_at timestamptz;

comment on column public.device_thresholds.temp_breach_episode_started_at is
  'Inicio del episodio actual de incumplimiento de temp; se borra al volver a rango.';
