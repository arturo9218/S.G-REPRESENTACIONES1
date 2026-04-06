import { VAPID_INJECT } from './vapid.inject';

export const environment = {
  production: false,
  /**
   * Creá un proyecto gratis en https://supabase.com → Project Settings → API.
   * Sin estos valores reales no se guardan usuarios (la app habla directo con Supabase; no hace falta otro servidor).
   */
  supabaseUrl: 'https://fohbhymulrmdsgrubtlo.supabase.co',
  supabaseAnonKey:
    'sb_publishable_wi66yVcEeu7Y_44mkfNHIg_9-nbkHeb',
  /**
   * Respaldo offline si falla el RPC is_app_admin. La lista real está en Supabase (admin_emails, sql/012).
   */
  adminEmails: ['arturoalmeida9218@gmail.com'] as readonly string[],

  /** Si true y hay sesión, dispositivos y lecturas se sincronizan con Supabase (ESP → Function → DB → app). */
  deviceCloudSync: true,
  ingestFunctionPath: '/functions/v1/ingest-reading',
  /** Intervalo de refresco de lecturas desde la nube (ms). Mínimo 2000 en el store. */
  readingsPollIntervalMs: 4000,
  /** Sin telemetría nueva por este tiempo => se considera desconectado. */
  deviceOfflineAfterMs: 90000,
  /** Si una lectura vieja solo tiene `power_w`, se estima I = P / V (debe coincidir con MAINS_V_RMS del ESP). */
  displayLineVoltageVForFallback: 220,
  /** Clave pública VAPID (build: variable VAPID_PUBLIC_KEY o valor en vapid.inject.ts). */
  vapidPublicKey: VAPID_INJECT,
  /**
   * Registrar Service Worker (requerido para Web Push). Debe ser true en dev si el build incluye ngsw (angular.json).
   */
  serviceWorkerEnabled: true,
};
