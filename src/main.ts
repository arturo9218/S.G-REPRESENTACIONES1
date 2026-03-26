import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';

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

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
