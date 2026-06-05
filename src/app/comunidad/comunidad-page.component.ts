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
import {
  DirectMessageService,
  type ChatContact,
  type PrivateMessage,
} from '../core/direct-message.service';
import { ToastService } from '../core/toast.service';

type ChatMode = 'private' | 'global';

@Component({
  selector: 'app-comunidad-page',
  templateUrl: './comunidad-page.component.html',
  styleUrls: ['./comunidad-page.component.scss'],
})
export class ComunidadPageComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('scrollBox') scrollBox?: ElementRef<HTMLElement>;

  mode: ChatMode = 'private';
  contacts: ChatContact[] = [];
  contactSearch = '';
  selectedPeerId: string | null = null;
  privateMessages: PrivateMessage[] = [];
  globalMessages: CommunityMessage[] = [];
  draft = '';
  loading = true;
  loadingContacts = false;
  sending = false;
  loadError = '';
  myUserId = '';
  myEmail = '';
  private scrollPending = false;

  constructor(
    private readonly globalChat: CommunityChatService,
    private readonly directChat: DirectMessageService,
    private readonly auth: AuthService,
    private readonly toast: ToastService
  ) {}

  get filteredContacts(): ChatContact[] {
    const q = this.contactSearch.trim().toLowerCase();
    if (!q) return this.contacts;
    return this.contacts.filter((c) => c.email.includes(q));
  }

  get selectedContact(): ChatContact | null {
    if (!this.selectedPeerId) return null;
    return this.contacts.find((c) => c.userId === this.selectedPeerId) ?? null;
  }

  async ngOnInit(): Promise<void> {
    const session = await this.auth.getSession();
    this.myUserId = session?.user?.id ?? '';
    this.myEmail = (session?.user?.email ?? '').trim().toLowerCase();
    await this.loadContacts();
    await this.reload();
  }

  ngOnDestroy(): void {
    this.globalChat.unsubscribe();
    this.directChat.unsubscribe();
  }

  ngAfterViewChecked(): void {
    if (this.scrollPending && this.scrollBox) {
      const el = this.scrollBox.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.scrollPending = false;
    }
  }

  async setMode(next: ChatMode): Promise<void> {
    if (this.mode === next) return;
    this.mode = next;
    this.globalChat.unsubscribe();
    this.directChat.unsubscribe();
    await this.reload();
  }

  async loadContacts(): Promise<void> {
    this.loadingContacts = true;
    const { rows, error } = await this.directChat.fetchContacts();
    this.loadingContacts = false;
    if (error) {
      const hint =
        error.includes('list_chat_contacts') || error.includes('private_messages')
          ? ' Ejecutá 052_private_messages.sql en Supabase.'
          : '';
      if (this.mode === 'private' && !this.loadError) {
        this.loadError = `${error}${hint}`;
      }
      return;
    }
    this.contacts = rows;
    if (this.mode === 'private' && !this.selectedPeerId && rows.length) {
      this.selectedPeerId = rows[0].userId;
    }
  }

  async selectPeer(peerId: string): Promise<void> {
    this.selectedPeerId = peerId;
    this.directChat.unsubscribe();
    await this.reloadPrivate();
    if (this.myUserId) {
      this.directChat.subscribeConversation(peerId, this.myUserId, () => {
        void this.reloadPrivate(true);
      });
    }
  }

  async reload(quiet = false): Promise<void> {
    if (this.mode === 'global') {
      await this.reloadGlobal(quiet);
    } else {
      if (!this.selectedPeerId && this.contacts.length) {
        this.selectedPeerId = this.contacts[0].userId;
      }
      await this.reloadPrivate(quiet);
      if (this.selectedPeerId && this.myUserId) {
        this.directChat.subscribeConversation(this.selectedPeerId, this.myUserId, () => {
          void this.reloadPrivate(true);
        });
      }
    }
  }

  async reloadGlobal(quiet = false): Promise<void> {
    if (!quiet) this.loading = true;
    this.loadError = '';
    const { rows, error } = await this.globalChat.fetchMessages(120);
    if (!quiet) this.loading = false;
    if (error) {
      const hint = error.includes('community_messages')
        ? ' Ejecutá 049_community_messages.sql.'
        : '';
      this.loadError = `${error}${hint}`;
      return;
    }
    this.globalMessages = rows;
    this.scrollPending = true;
    this.globalChat.subscribeNewMessages(() => {
      void this.reloadGlobal(true);
    });
  }

  async reloadPrivate(quiet = false): Promise<void> {
    if (!this.selectedPeerId) {
      if (!quiet) this.loading = false;
      this.privateMessages = [];
      return;
    }
    if (!quiet) this.loading = true;
    this.loadError = '';
    const { rows, error } = await this.directChat.fetchConversation(this.selectedPeerId, 150);
    if (!quiet) this.loading = false;
    if (error) {
      const hint = error.includes('private_messages')
        ? ' Ejecutá 052_private_messages.sql en Supabase.'
        : '';
      this.loadError = `${error}${hint}`;
      return;
    }
    this.privateMessages = rows;
    this.scrollPending = true;
  }

  async send(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    let error: string | null = null;
    if (this.mode === 'global') {
      ({ error } = await this.globalChat.sendMessage(this.draft, this.myEmail));
    } else {
      if (!this.selectedPeerId) {
        error = 'Elegí un usuario de la lista.';
      } else {
        ({ error } = await this.directChat.sendMessage(
          this.selectedPeerId,
          this.draft,
          this.myEmail
        ));
      }
    }
    this.sending = false;
    if (error) {
      this.toast.error(error);
      return;
    }
    this.draft = '';
    if (this.mode === 'global') {
      await this.reloadGlobal(true);
    } else {
      await this.reloadPrivate(true);
    }
  }

  async removePrivate(msg: PrivateMessage): Promise<void> {
    if (!this.isMinePrivate(msg)) return;
    if (!confirm('¿Eliminar tu mensaje?')) return;
    const { error } = await this.directChat.deleteMessage(msg.id);
    if (error) {
      this.toast.error(error);
      return;
    }
    this.privateMessages = this.privateMessages.filter((m) => m.id !== msg.id);
  }

  async removeGlobal(msg: CommunityMessage): Promise<void> {
    if (!this.isMineGlobal(msg)) return;
    if (!confirm('¿Eliminar tu mensaje?')) return;
    const { error } = await this.globalChat.deleteMessage(msg.id);
    if (error) {
      this.toast.error(error);
      return;
    }
    this.globalMessages = this.globalMessages.filter((m) => m.id !== msg.id);
  }

  isMinePrivate(msg: PrivateMessage): boolean {
    return !!this.myUserId && msg.senderId === this.myUserId;
  }

  isMineGlobal(msg: CommunityMessage): boolean {
    return !!this.myUserId && msg.userId === this.myUserId;
  }

  contactLabel(c: ChatContact): string {
    return this.emailLabel(c.email);
  }

  emailLabel(email: string): string {
    const e = email.trim();
    if (!e) return 'Usuario';
    const at = e.indexOf('@');
    if (at <= 1) return e;
    return e.slice(0, 1).toUpperCase() + e.slice(1, at);
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
