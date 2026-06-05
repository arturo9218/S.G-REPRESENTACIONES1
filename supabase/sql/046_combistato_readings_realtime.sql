-- Habilita Supabase Realtime en combistato_readings (INSERT desde ingest-reading).
-- La app se actualiza al instante cuando llega una fila nueva, sin acortar el intervalo del ESP.
-- Ejecutar en SQL Editor después de 035_combistato_readings.sql.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'combistato_readings'
  ) then
    alter publication supabase_realtime add table public.combistato_readings;
  end if;
end $$;
