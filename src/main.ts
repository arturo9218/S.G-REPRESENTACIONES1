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

/** En local, un Service Worker viejo de producción deja la pestaña en negro o con caché rota. */
async function clearDevServiceWorkers(): Promise<void> {
  if (environment.production || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}

const sentryDsn = typeof environment.sentryDsn === 'string' ? environment.sentryDsn.trim() : '';
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: environment.production ? 'production' : 'development',
    tracesSampleRate: environment.production ? 0.12 : 0,
  });
}

void clearDevServiceWorkers().finally(() => {
  platformBrowserDynamic()
    .bootstrapModule(AppModule)
    .catch((err) => {
      console.error(err);
      const root = document.querySelector('app-root');
      if (root) {
        root.innerHTML =
          '<div style="padding:2rem;min-height:100vh;background:#0b1220;color:#e8eef7;font-family:system-ui">' +
          '<h1 style="margin-top:0">Error al iniciar la app</h1>' +
          '<p>Recargá con <strong>Ctrl+Shift+R</strong> o abrí <a href="/login" style="color:#38bdf8">/login</a>.</p>' +
          '<pre style="color:#fca5a5;white-space:pre-wrap;font-size:0.8rem">' +
          String(err?.message ?? err) +
          '</pre></div>';
      }
    });
});
