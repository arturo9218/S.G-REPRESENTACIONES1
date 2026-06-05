import { Injectable } from '@angular/core';

/**
 * Tono + vibración + notificación del sistema al recibir mensajes (estilo aviso de chat).
 * En el móvil: instalá la PWA y permití notificaciones para que suene con la app en segundo plano.
 */
@Injectable({ providedIn: 'root' })
export class ChatNotificationService {
  private audioCtx: AudioContext | null = null;
  private permissionAsked = false;

  /** Pedir permiso una vez (p. ej. al entrar a Comunidad). */
  async ensurePermission(): Promise<NotificationPermission | 'unsupported'> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    if (this.permissionAsked) return Notification.permission;
    this.permissionAsked = true;
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  /** Sonido corto tipo mensaje entrante + vibración en móvil. */
  playIncomingSound(): void {
    if (typeof window === 'undefined') return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      const t = ctx.currentTime;
      const tone = (freq: number, start: number, dur: number, vol = 0.28): void => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + start);
        g.gain.exponentialRampToValueAtTime(vol, t + start + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t + start);
        o.stop(t + start + dur + 0.02);
      };
      tone(880, 0, 0.1);
      tone(1174, 0.11, 0.14, 0.22);
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([70, 50, 90]);
      }
    } catch {
      /* sin audio */
    }
  }

  async notifyMessage(title: string, body: string, tag: string): Promise<void> {
    this.playIncomingSound();
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const text = body.trim();
    const preview = text.length > 160 ? `${text.slice(0, 157)}…` : text;
    try {
      const n = new Notification(title, {
        body: preview || 'Nuevo mensaje',
        tag,
        icon: '/assets/icons/icon-192.svg',
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* Notification bloqueada */
    }
  }
}
