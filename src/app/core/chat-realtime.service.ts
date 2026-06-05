import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { ChatNotificationService } from './chat-notification.service';
import {
  CommunityChatService,
  type CommunityMessage,
} from './community-chat.service';
import {
  DirectMessageService,
  type PrivateMessage,
} from './direct-message.service';

/**
 * Escucha mensajes en toda la app (no solo en Comunidad) y dispara aviso + sonido.
 */
@Injectable({ providedIn: 'root' })
export class ChatRealtimeService {
  readonly global$ = new Subject<CommunityMessage>();
  readonly private$ = new Subject<PrivateMessage>();

  private myUserId = '';
  private running = false;

  constructor(
    private readonly auth: AuthService,
    private readonly globalChat: CommunityChatService,
    private readonly directChat: DirectMessageService,
    private readonly notify: ChatNotificationService,
    private readonly zone: NgZone
  ) {}

  async start(): Promise<void> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) {
      this.stop();
      return;
    }
    if (this.running && this.myUserId === uid) return;
    this.stop();
    this.myUserId = uid;
    this.running = true;
    await this.notify.ensurePermission();

    this.globalChat.subscribeNewMessages((msg) => {
      this.zone.run(() => this.onGlobal(msg));
    });
    this.directChat.subscribeIncoming(uid, (msg) => {
      this.zone.run(() => this.onPrivate(msg));
    });
  }

  stop(): void {
    this.running = false;
    this.myUserId = '';
    this.globalChat.unsubscribe();
    this.directChat.unsubscribe();
  }

  private onGlobal(msg: CommunityMessage): void {
    if (msg.userId === this.myUserId) return;
    this.global$.next(msg);
    const who = this.shortEmail(msg.authorEmail);
    void this.notify.notifyMessage(`Comunidad — ${who}`, msg.body, `community-${msg.id}`);
  }

  private onPrivate(msg: PrivateMessage): void {
    if (msg.senderId === this.myUserId) return;
    this.private$.next(msg);
    const who = this.shortEmail(msg.senderEmail);
    void this.notify.notifyMessage(`Mensaje de ${who}`, msg.body, `dm-${msg.senderId}-${msg.id}`);
  }

  private shortEmail(email: string): string {
    const e = email.trim();
    const at = e.indexOf('@');
    if (at <= 1) return e || 'Usuario';
    return e.slice(0, 1).toUpperCase() + e.slice(1, at);
  }
}
