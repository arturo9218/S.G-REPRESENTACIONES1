import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { DirectMessageService } from './direct-message.service';

/** Total de mensajes privados sin leer (para campana en menú Comunidad). */
@Injectable({ providedIn: 'root' })
export class ChatUnreadService {
  private readonly totalSubject = new BehaviorSubject(0);
  readonly total$ = this.totalSubject.asObservable();

  constructor(private readonly directChat: DirectMessageService) {}

  get total(): number {
    return this.totalSubject.value;
  }

  clear(): void {
    this.totalSubject.next(0);
  }

  async refresh(): Promise<void> {
    const { rows, error } = await this.directChat.fetchContacts();
    if (error) return;
    const total = rows.reduce((s, c) => s + c.unreadCount, 0);
    this.totalSubject.next(total);
  }
}
