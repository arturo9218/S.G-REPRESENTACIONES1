import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import * as Sentry from '@sentry/angular-ivy';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

/**
 * El mail de recuperación abre la URL con los tokens en el hash (#...).
 * Si cae en / o /login, el router de Angular puede perder el fragmento al redirigir.
 * Llevamos el hash a /restablecer-contrasena antes de bootstrapear.
 */
function ensureRecoveryHashOnResetRoute(): void {
  try {
    const w = typeof window !== 'undefined' ? window : null;
    if (!w?.location?.hash || w.location.hash.length < 2) return;
    const h = w.location.hash;
    const lower = h.toLowerCase();
    if (!h.includes('access_token') || !lower.includes('type=recovery')) return;
    if (w.location.pathname.includes('restablecer-contrasena')) return;
    w.history.replaceState(null, '', `${w.location.origin}/restablecer-contrasena${h}`);
  } catch {
    /* ignore */
  }
}

ensureRecoveryHashOnResetRoute();

const sentryDsn = typeof environment.sentryDsn === 'string' ? environment.sentryDsn.trim() : '';
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: environment.production ? 'production' : 'development',
    tracesSampleRate: environment.production ? 0.12 : 0,
  });
}

platformBrowserDynamic().bootstrapModule(AppModule).catch((err) => console.error(err));
