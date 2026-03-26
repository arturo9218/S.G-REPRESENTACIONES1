export const environment = {
  production: false,
  /**
   * Creá un proyecto gratis en https://supabase.com → Project Settings → API.
   * Sin estos valores reales no se guardan usuarios (la app habla directo con Supabase; no hace falta otro servidor).
   */
  supabaseUrl: 'https://fohbhymulrmdsgrubtlo.supabase.co',
  supabaseAnonKey:
    'sb_publishable_wi66yVcEeu7Y_44mkfNHIg_9-nbkHeb',
  /** Si true y hay sesión, dispositivos y lecturas se sincronizan con Supabase (ESP → Function → DB → app). */
  deviceCloudSync: true,
  ingestFunctionPath: '/functions/v1/ingest-reading',
  /** Intervalo de refresco de lecturas desde la nube (ms). Mínimo 2000 en el store. */
  readingsPollIntervalMs: 4000,
  /** Sin telemetría nueva por este tiempo => se considera desconectado. */
  deviceOfflineAfterMs: 90000,
};
