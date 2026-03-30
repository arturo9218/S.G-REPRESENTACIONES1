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
          'Falta la clave pública VAPID en environment (vapidPublicKey). Generala con web-push y copiala al build.',
      };
    }
    if (!this.swPush.isEnabled) {
      return {
        ok: false,
        message:
          'El service worker está desactivado en desarrollo. Probá en la URL de Vercel (build producción).',
      };
    }
    const {
      data: { user },
    } = await this.auth.client.auth.getUser();
    if (!user) {
      return { ok: false, message: 'Iniciá sesión para activar avisos en este navegador.' };
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
          'Activado. Vas a recibir avisos de umbral y de desconexión (según navegador y permisos).',
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
