import { Injectable } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

function uint8ToBase64(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
          'Falta VAPID_PUBLIC_KEY: definila en el entorno (Vercel / local) y ejecutá npm start o npm run build para regenerar src/environments/vapid.inject.ts (script scripts/inject-vapid.cjs). En Supabase Edge Functions deben coincidir VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.',
      };
    }
    if (!this.swPush.isEnabled) {
      return {
        ok: false,
        message:
          'El Service Worker no está activo (ngsw). Revisá que environment.serviceWorkerEnabled sea true y que el build incluya el SW (angular.json → serviceWorker). Tras cambiarlo, recargá la página con Ctrl+F5.',
      };
    }
    const {
      data: { user },
    } = await this.auth.client.auth.getUser();
    if (!user) {
      return { ok: false, message: 'Iniciá sesión para activar avisos en este navegador.' };
    }
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'denied') {
        return {
          ok: false,
          message:
            'Las notificaciones están bloqueadas. En el navegador o en Ajustes del sistema, permití notificaciones para este sitio.',
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
      const sub = await this.swPush.requestSubscription({ serverPublicKey: pk });
      const p256dh = uint8ToBase64(sub.getKey('p256dh'));
      const auth = uint8ToBase64(sub.getKey('auth'));
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
      return {
        ok: true,
        message:
          'Activado. En Supabase (secrets de Edge Functions) tenés que tener el mismo par VAPID que en Vercel: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT (mailto:tu@email). Si no coinciden, no llega ningún push.',
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
