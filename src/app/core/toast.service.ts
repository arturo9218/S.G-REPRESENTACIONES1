import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastMessage {
  text: string;
  kind: ToastKind;
}

/** Avisos breves globales (comandos PRO300, errores de red, etc.). */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly subject = new BehaviorSubject<ToastMessage | null>(null);
  readonly toast$ = this.subject.asObservable();
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  show(text: string, kind: ToastKind = 'info', durationMs = 4000): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.subject.next({ text: trimmed, kind });
    this.hideTimer = setTimeout(() => this.dismiss(), durationMs);
  }

  success(text: string, durationMs = 4000): void {
    this.show(text, 'success', durationMs);
  }

  error(text: string, durationMs = 5500): void {
    this.show(text, 'error', durationMs);
  }

  dismiss(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.subject.next(null);
  }
}
