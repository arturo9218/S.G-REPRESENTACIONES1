import {
  AfterViewChecked,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { AuthService } from '../core/auth.service';
import {
  CommunityChatService,
  type CommunityMessage,
} from '../core/community-chat.service';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-comunidad-page',
  templateUrl: './comunidad-page.component.html',
  styleUrls: ['./comunidad-page.component.scss'],
})
export class ComunidadPageComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('scrollBox') scrollBox?: ElementRef<HTMLElement>;

  messages: CommunityMessage[] = [];
  draft = '';
  loading = true;
  sending = false;
  loadError = '';
  myUserId = '';
  myEmail = '';
  private scrollPending = false;

  constructor(
    private readonly chat: CommunityChatService,
    private readonly auth: AuthService,
    private readonly toast: ToastService
  ) {}

  async ngOnInit(): Promise<void> {
    const session = await this.auth.getSession();
    this.myUserId = session?.user?.id ?? '';
    this.myEmail = (session?.user?.email ?? '').trim().toLowerCase();
    await this.reload();
    this.chat.subscribeNewMessages(() => {
      void this.reload(true);
    });
  }

  ngOnDestroy(): void {
    this.chat.unsubscribe();
  }

  ngAfterViewChecked(): void {
    if (this.scrollPending && this.scrollBox) {
      const el = this.scrollBox.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.scrollPending = false;
    }
  }

  async reload(quiet = false): Promise<void> {
    if (!quiet) this.loading = true;
    this.loadError = '';
    const { rows, error } = await this.chat.fetchMessages(120);
    if (!quiet) this.loading = false;
    if (error) {
      const hint = error.includes('community_messages')
        ? ' Ejecutá en Supabase el SQL 049_community_messages.sql.'
        : '';
      this.loadError = `${error}${hint}`;
      return;
    }
    this.messages = rows;
    this.scrollPending = true;
  }

  async send(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    const { error } = await this.chat.sendMessage(this.draft, this.myEmail);
    this.sending = false;
    if (error) {
      this.toast.error(error);
      return;
    }
    this.draft = '';
    await this.reload(true);
  }

  async remove(msg: CommunityMessage): Promise<void> {
    const q = this.isMine(msg) ? '¿Eliminar tu mensaje?' : '¿Eliminar este mensaje?';
    if (!confirm(q)) return;
    const { error } = await this.chat.deleteMessage(msg.id);
    if (error) {
      this.toast.error(error);
      return;
    }
    this.messages = this.messages.filter((m) => m.id !== msg.id);
  }

  isMine(msg: CommunityMessage): boolean {
    return !!this.myUserId && msg.userId === this.myUserId;
  }

  authorLabel(msg: CommunityMessage): string {
    const email = msg.authorEmail.trim();
    if (!email) return 'Usuario';
    const at = email.indexOf('@');
    if (at <= 1) return email;
    return email.slice(0, 1).toUpperCase() + email.slice(1, at);
  }

  timeLabel(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch {
      return iso;
    }
  }

  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void this.send();
    }
  }
}
