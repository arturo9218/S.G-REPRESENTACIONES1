import { VAPID_INJECT } from './vapid.inject';

export const environment = {
  production: true,
  supabaseUrl: 'https://fohbhymulrmdsgrubtlo.supabase.co',
  supabaseAnonKey:
    'sb_publishable_wi66yVcEeu7Y_44mkfNHIg_9-nbkHeb',
  deviceCloudSync: true,
  ingestFunctionPath: '/functions/v1/ingest-reading',
  readingsPollIntervalMs: 4000,
  deviceOfflineAfterMs: 90000,
  displayLineVoltageVForFallback: 220,
  vapidPublicKey: VAPID_INJECT,
};
