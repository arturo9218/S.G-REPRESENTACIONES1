import { Injectable } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

/**
 * Claves del PushSubscription en base64url (RFC 4648 §5), como en `subscription.toJSON()`.
 * Antes se usaba btoa (base64 con +/) y la librería web-push en el Edge Function puede fallar al cifrar.
 */
function keysFromPushSubscription(sub: PushSubscription): { p256dh: string; auth: string } | null {
  const j = sub.toJSON();
  const pk = j.keys?.['p256dh'];
  const ak = j.keys?.['auth'];
  if (!pk || !ak) return null;
  return { p256dh: pk, auth: ak };
}

function formatPushSubscribeError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('push service error') || lower.includes('registration failed')) {
    return (
      `${raw} — Suele ser red inestable o datos móviles limitando el registro con Google (FCM). ` +
      'Activá las notificaciones conectado a Wi‑Fi (una vez alcanza; después suelen llegar también con datos). ' +
      'Desactivá ahorro de datos / VPN, mejor señal 4G o probá de nuevo. ' +
      'Si con Wi‑Fi tampoco funciona, recién ahí revisá VAPID en el hosting del front y en Supabase (mismo par de claves). ' +
      'Chrome/Safari directo (no WebView de WhatsApp). iPhone: PWA en inicio (iOS 16.4+).'
    );
  }
  return raw;
}

/** Reintenta registro FCM ante cortes breves de red (típico en 4G). */
async function requestSubscriptionWithRetry(
  swPush: SwPush,
  serverPublicKey: string,
  maxAttempts = 3
): Promise<PushSubscription> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await swPush.requestSubscription({ serverPublicKey });
    } catch (e) {
      last = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw last;
}

export type WebPushUiState = 'loading' | 'unsupported' | 'none' | 'active';

@Injectable({
  providedIn: 'root',
})
export class WebPushService {
  constructor(
    private readonly swPush: SwPush,
    private readonly auth: AuthService
  ) {}

  async getUiState(): Promise<WebPushUiState> {
    if (typeof window === 'undefined' || !('PushManager' in window)) {
      return 'unsupported';
    }
    if (!this.swPush.isEnabled) {
      return 'unsupported';
    }
    const sub = await firstValueFrom(this.swPush.subscription);
    return sub ? 'active' : 'none';
  }

  /**
   * Notificaciones del sistema vía Web Push (funcionan con la pestaña cerrada en Chrome/Edge;
   * Safari iOS requiere añadir la PWA a inicio en versiones recientes).
   */
  async subscribeBackgroundAlerts(): Promise<{ ok: boolean; message: string }> {
    const pk = environment.vapidPublicKey?.trim();
    if (!pk) {
      return {
        ok: false,
        message:
          'Falta VAPID_PUBLIC_KEY: definila en el entorno del build (local o CI/hosting) y ejecutá npm start o npm run build para regenerar src/environments/vapid.inject.ts (script scripts/inject-vapid.cjs). En Supabase Edge Functions deben coincidir VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.',
      };
    }
    if (!this.swPush.isEnabled) {
      return {
        ok: false,
        message:
          'El Service Worker no está activo (ngsw). Abrí la app publicada en HTTPS (Vercel), no ng serve. Agregá a Inicio en Android si hace falta.',
      };
    }
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'denied') {
        return {
          ok: false,
          message:
            'Notificaciones bloqueadas. Android: Ajustes → Apps → Chrome → Notificaciones → permitir. También el sitio en Chrome (candado → permisos).',
        };
      }
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          return {
            ok: false,
            message: 'Sin permiso de notificaciones no se puede recibir avisos con la app cerrada.',
          };
        }
      }
    }
    try {
      // Android: suscribir FCM antes de otros awaits (el gesto del botón se pierde si tardamos).
      const sub = await requestSubscriptionWithRetry(this.swPush, pk);
      const {
        data: { user },
      } = await this.auth.client.auth.getUser();
      if (!user) {
        return { ok: false, message: 'Iniciá sesión para activar avisos en este celular.' };
      }
      const keys = keysFromPushSubscription(sub);
      if (!keys) {
        return {
          ok: false,
          message: 'No se pudieron leer las claves de la suscripción push (p256dh/auth). Probá de nuevo o otro navegador.',
        };
      }
      const { p256dh, auth } = keys;
      const { error } = await this.auth.client.from('push_subscriptions').upsert(
        {
          user_id: user.id,
          endpoint: sub.endpoint,
          p256dh,
          auth,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'endpoint' }
      );
      if (error) {
        return { ok: false, message: error.message };
      }
      const { count, error: verifyErr } = await this.auth.client
        .from('push_subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);
      if (verifyErr) {
        return { ok: false, message: `Suscripción local OK pero no se pudo verificar en servidor: ${verifyErr.message}` };
      }
      if (!count) {
        return {
          ok: false,
          message:
            'El navegador se suscribió pero no quedó guardado en push_subscriptions. Revisá RLS o volvé a iniciar sesión.',
        };
      }
      return {
        ok: true,
        message:
          `Activado (${count} dispositivo(s) en servidor). Cerrá la app y usá "Probar con app cerrada". VAPID en Vercel y Supabase deben ser el mismo par.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: formatPushSubscribeError(msg) };
    }
  }

  /** Envía una notificación de prueba al usuario actual (útil con la app cerrada). */
  async sendTestPush(): Promise<{ ok: boolean; message: string }> {
    const session = await this.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      return { ok: false, message: 'Iniciá sesión para probar.' };
    }
    const base = environment.supabaseUrl?.replace(/\/$/, '');
    const anon = environment.supabaseAnonKey?.trim();
    if (!base || !anon) {
      return { ok: false, message: 'Falta configuración de Supabase en la app.' };
    }
    try {
      const res = await fetch(`${base}/functions/v1/send-test-push`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anon,
          'Content-Type': 'application/json',
        },
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && Number(body['sent'] ?? 0) > 0) {
        return {
          ok: true,
          message: 'Push enviado. Cerrá la app ahora y debería aparecer la notificación en unos segundos.',
        };
      }
      const skipped = String(body['skipped'] ?? '');
      const lastError = String(body['lastError'] ?? '');
      if (skipped === 'no_subscriptions' || skipped.includes('no_subscriptions')) {
        return {
          ok: false,
          message: 'No hay registro push para tu usuario. Tocá primero "Activar tono y notificaciones (FCM)".',
        };
      }
      if (skipped === 'vapid_not_configured') {
        return {
          ok: false,
          message: 'Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en secrets de Supabase Edge Functions.',
        };
      }
      if (lastError.includes('401') || lastError.includes('403')) {
        return {
          ok: false,
          message:
            'VAPID no coincide entre Vercel y Supabase. La clave pública del build debe ser par de la privada en secrets.',
        };
      }
      return {
        ok: false,
        message: `No se pudo entregar (${res.status}): ${skipped || lastError || 'error desconocido'}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: msg };
    }
  }

  async unsubscribeBackground(): Promise<{ ok: boolean; message: string }> {
    if (!this.swPush.isEnabled) {
      return { ok: true, message: 'Nada que desactivar en este entorno.' };
    }
    const sub = await firstValueFrom(this.swPush.subscription);
    if (!sub) {
      return { ok: true, message: 'No había suscripción activa en este navegador.' };
    }
    await this.auth.client.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    try {
      await this.swPush.unsubscribe();
    } catch {
      /* ya expirada */
    }
    return { ok: true, message: 'Suscripción quitada de este navegador.' };
  }
}
