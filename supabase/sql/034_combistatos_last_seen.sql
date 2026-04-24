-- Última telemetría recibida por `ingest-reading` cuando el module_id corresponde a un combistato (no a `devices`).
-- Ejecutar en Supabase SQL Editor después de 033_combistatos.sql.

alter table public.combistatos
  add column if not exists last_seen_at timestamptz;

comment on column public.combistatos.last_seen_at is 'Marca de tiempo del último POST de telemetría aceptado (ingest-reading, fila combistato).';

create index if not exists idx_combistatos_last_seen
  on public.combistatos (last_seen_at desc nulls last);
