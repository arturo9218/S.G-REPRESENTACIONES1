import { Injectable } from '@angular/core';
import {
  type ChatSoundPresetId,
  loadChatNotificationSettings,
} from './chat-notification-settings';

@Injectable({ providedIn: 'root' })
export class ChatNotificationService {
  private audioCtx: AudioContext | null = null;
  private customAudio: HTMLAudioElement | null = null;
  private permissionAsked = false;

  getSettings() {
    return loadChatNotificationSettings();
  }

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

  /** Reproduce el tono elegido (preset o archivo propio). */
  playIncomingSound(): void {
    if (typeof window === 'undefined') return;
    const settings = loadChatNotificationSettings();
    if (settings.soundId === 'custom' && settings.customSoundDataUrl) {
      try {
        if (!this.customAudio) {
          this.customAudio = new Audio();
        }
        this.customAudio.volume = 1;
        this.customAudio.src = settings.customSoundDataUrl;
        this.customAudio.currentTime = 0;
        void this.customAudio.play().catch(() => this.playPreset('default'));
      } catch {
        this.playPreset('default');
      }
      this.vibrate();
      return;
    }
    this.playPreset(settings.soundId === 'custom' ? 'default' : settings.soundId);
    this.vibrate();
  }

  playPreset(id: ChatSoundPresetId): void {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') void ctx.resume();
      const t = ctx.currentTime;
      const tone = (
        freq: number,
        start: number,
        dur: number,
        vol = 0.62,
        wave: OscillatorType = 'square'
      ): void => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = wave;
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + start);
        g.gain.exponentialRampToValueAtTime(vol, t + start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t + start);
        o.stop(t + start + dur + 0.02);
      };

      switch (id) {
        case 'double':
          tone(988, 0, 0.07, 0.7);
          tone(1318, 0.08, 0.09, 0.72);
          tone(988, 0.17, 0.07, 0.7);
          tone(1318, 0.25, 0.09, 0.72);
          break;
        case 'soft':
          tone(660, 0, 0.14, 0.45, 'sine');
          break;
        case 'bell':
          tone(784, 0, 0.1, 0.68);
          tone(1174, 0.07, 0.14, 0.7);
          break;
        case 'chime':
          tone(523, 0, 0.08, 0.6, 'sine');
          tone(659, 0.07, 0.1, 0.62, 'sine');
          tone(784, 0.14, 0.12, 0.65, 'sine');
          break;
        default:
          tone(880, 0, 0.09, 0.75);
          tone(1174, 0.1, 0.12, 0.78);
      }
    } catch {
      /* sin audio */
    }
  }

  private vibrate(): void {
    try {
      navigator.vibrate?.([120, 80, 140, 80, 120]);
    } catch {
      /* */
    }
  }

  /** Siempre: sonido + notificación del sistema (si hay permiso). */
  async notifyMessage(title: string, body: string, tag: string): Promise<void> {
    this.playIncomingSound();
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const text = body.trim();
    const preview = text.length > 180 ? `${text.slice(0, 177)}…` : text;
    try {
      const n = new Notification(title, {
        body: preview || 'Nuevo mensaje',
        tag,
        icon: '/assets/icons/icon-192.svg',
        silent: false,
        renotify: true,
      });
      n.onclick = () => {
        window.focus();
        if (!window.location.pathname.includes('comunidad')) {
          window.location.href = '/comunidad';
        }
        n.close();
      };
    } catch {
      /* */
    }
  }
}
