import { Component, OnDestroy, OnInit } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { Subscription, fromEvent, interval } from 'rxjs';
import { filter } from 'rxjs/operators';
import { environment } from '../environments/environment';
import { ConnectivityService } from './core/connectivity.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit, OnDestroy {
  /** Hay build nuevo en el servidor; el SW ya lo descargó y puede activarse. */
  updateAvailable = false;

  /** Conexión a internet (navegador / PWA). */
  online = true;

  private versionSub?: Subscription;
  private pollSub?: Subscription;
  private visSub?: Subscription;
  private connSub?: Subscription;

  constructor(
    private readonly swUpdate: SwUpdate,
    private readonly connectivity: ConnectivityService
  ) {}

  ngOnInit(): void {
    this.online = this.connectivity.isOnline;
    this.connSub = this.connectivity.online$.subscribe((v) => {
      this.online = v;
    });

    if (!environment.production || !this.swUpdate.isEnabled) {
      return;
    }

    this.versionSub = this.swUpdate.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => {
        this.updateAvailable = true;
        this.playUpdateAvailableChime();
        this.showUpdateAvailableNotification();
        try {
          navigator.vibrate?.(120);
        } catch {
          /* */
        }
      });

    void this.swUpdate.checkForUpdate();

    this.pollSub = interval(5 * 60 * 1000).subscribe(() => {
      void this.swUpdate.checkForUpdate();
    });

    this.visSub = fromEvent(document, 'visibilitychange').subscribe(() => {
      if (document.visibilityState === 'visible') {
        void this.swUpdate.checkForUpdate();
      }
    });
  }

  ngOnDestroy(): void {
    this.connSub?.unsubscribe();
    this.versionSub?.unsubscribe();
    this.pollSub?.unsubscribe();
    this.visSub?.unsubscribe();
  }

  /** Recarga la app tras recuperar conexión o para reintentar peticiones fallidas. */
  reloadApp(): void {
    if (typeof location !== 'undefined') {
      location.reload();
    }
  }

  dismissUpdatePrompt(): void {
    this.updateAvailable = false;
  }

  async activateNewVersion(): Promise<void> {
    try {
      await this.swUpdate.activateUpdate();
      document.location.reload();
    } catch {
      document.location.reload();
    }
  }

  /** Tono corto distinto a las alarmas del panel (solo aviso de nueva versión). */
  private playUpdateAvailableChime(): void {
    if (typeof window === 'undefined') return;
    try {
      const Ctor = (window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
        | typeof AudioContext
        | undefined;
      if (!Ctor) return;
      const ctx = new Ctor();
      const resume = () => {
        if (ctx.state === 'suspended') void ctx.resume();
      };
      resume();
      const t0 = ctx.currentTime;
      const playOne = (start: number, freq: number, dur: number) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + start);
        g.gain.exponentialRampToValueAtTime(0.1, t0 + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + dur + 0.02);
      };
      playOne(0, 523.25, 0.12);
      playOne(0.14, 659.25, 0.14);
      const end = t0 + 0.35;
      window.setTimeout(() => {
        void ctx.close();
      }, Math.max(800, (end - t0) * 1000 + 200));
    } catch {
      /* autoplay u otro bloqueo */
    }
  }

  /** Si el usuario ya concedió notificaciones del sitio, aviso del sistema además del banner. */
  private showUpdateAvailableNotification(): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      const icon =
        typeof location !== 'undefined' ? `${location.origin}/favicon.ico` : undefined;
      new Notification('SG Monitoreo — actualización', {
        body: 'Hay una versión nueva. Usá "Actualizar ahora" en la barra superior.',
        tag: 'sg-pwa-update',
        renotify: true,
        icon,
      });
    } catch {
      /* */
    }
  }
}
