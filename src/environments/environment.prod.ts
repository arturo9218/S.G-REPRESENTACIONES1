import { VAPID_INJECT } from './vapid.inject';

export const environment = {
  production: true,
  supabaseUrl: 'https://fohbhymulrmdsgrubtlo.supabase.co',
  supabaseAnonKey:
    'sb_publishable_wi66yVcEeu7Y_44mkfNHIg_9-nbkHeb',
  /** Respaldo offline; admins reales: tabla admin_emails (Supabase). */
  adminEmails: ['arturoalmeida9218@gmail.com'] as readonly string[],
  deviceCloudSync: true,
  ingestFunctionPath: '/functions/v1/ingest-reading',
  /** Panel: menos consultas a PostgREST (antes 4 s). Ajustá si necesitás UI más reactiva. */
  readingsPollIntervalMs: 15000,
  deviceOfflineAfterMs: 90000,
  displayLineVoltageVForFallback: 220,
  vapidPublicKey: VAPID_INJECT,
  serviceWorkerEnabled: true,

  /** DSN de Sentry para producción; vacío = desactivado. */
  sentryDsn: '',
};
