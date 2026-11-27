-- Realtime en device_readings (paneles genéricos / PRO400 en devices).
-- Ejecutar después de 001_devices_and_readings.sql.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_readings'
  ) then
    alter publication supabase_realtime add table public.device_readings;
  end if;
end $$;
