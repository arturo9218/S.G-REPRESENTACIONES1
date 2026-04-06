import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * Estado en línea / fuera de línea del navegador (PWA instalada o pestaña).
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly onlineSubject = new BehaviorSubject<boolean>(this.readNavigatorOnline());

  /** Emite true cuando hay red (según el navegador). */
  readonly online$ = this.onlineSubject.asObservable();

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => this.onlineSubject.next(true));
    window.addEventListener('offline', () => this.onlineSubject.next(false));
  }

  get isOnline(): boolean {
    return this.onlineSubject.value;
  }

  private readNavigatorOnline(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  }
}
