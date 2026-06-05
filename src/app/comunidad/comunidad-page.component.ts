import {
  AfterViewChecked,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import {
  CHAT_SOUND_PRESETS,
  type ChatNotificationSettings,
  type ChatSoundPresetId,
  loadChatNotificationSettings,
  readCustomSoundFile,
  saveChatNotificationSettings,
} from '../core/chat-notification-settings';
import { ChatNotificationService } from '../core/chat-notification.service';
import { ChatRealtimeService } from '../core/chat-realtime.service';
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
import { WebPushService } from '../core/web-push.service';

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
  notifyPermission: NotificationPermission | 'unsupported' = 'unsupported';
  pushUiState = '';
  soundSettings: ChatNotificationSettings = loadChatNotificationSettings();
  readonly soundPresets = CHAT_SOUND_PRESETS;
  myUserId = '';
  myEmail = '';
  private scrollPending = false;
  private uiSubs: Subscription[] = [];

  constructor(
    private readonly globalChat: CommunityChatService,
    private readonly directChat: DirectMessageService,
    private readonly chatNotify: ChatNotificationService,
    private readonly chatRealtime: ChatRealtimeService,
    private readonly webPush: WebPushService,
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
    this.soundSettings = loadChatNotificationSettings();
    this.notifyPermission = await this.chatNotify.ensurePermission();
    void this.chatRealtime.start();
    this.uiSubs.push(
      this.chatRealtime.global$.subscribe((msg) => {
        if (this.mode === 'global') void this.reloadGlobal(true);
      }),
      this.chatRealtime.private$.subscribe((msg) => {
        if (this.mode === 'private' && this.selectedPeerId === msg.senderId) {
          void this.reloadPrivate(true);
        }
      })
    );
    await this.loadContacts();
    await this.reload();
  }

  ngOnDestroy(): void {
    this.uiSubs.forEach((s) => s.unsubscribe());
  }

  ngAfterViewChecked(): void {
    if (this.scrollPending && this.scrollBox) {
      const el = this.scrollBox.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.scrollPending = false;
    }
  }

  async enableAlerts(): Promise<void> {
    this.notifyPermission = await this.chatNotify.ensurePermission();
    const push = await this.webPush.subscribeBackgroundAlerts();
    this.pushUiState = push.message;
    if (this.notifyPermission === 'granted') {
      this.toast.success(
        push.ok
          ? 'Avisos activos: sonido en la app y notificaciones con la pantalla apagada.'
          : 'Permiso OK en este navegador. Para segundo plano: ' + push.message
      );
      this.chatNotify.playIncomingSound();
    } else if (this.notifyPermission === 'denied') {
      this.toast.show(
        'Permiso bloqueado. En el teléfono: ajustes → notificaciones para AR Monitoreo.',
        'info'
      );
    }
  }

  onSoundPresetChange(id: ChatSoundPresetId): void {
    this.soundSettings = { ...this.soundSettings, soundId: id };
    saveChatNotificationSettings(this.soundSettings);
    if (id !== 'custom') this.chatNotify.playIncomingSound();
  }

  async onCustomSoundFile(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!file) return;
    const dataUrl = await readCustomSoundFile(file);
    if (!dataUrl) {
      this.toast.show('Archivo no válido o muy pesado (máx. ~800 KB). Usá mp3, wav u ogg.', 'info');
      return;
    }
    this.soundSettings = {
      soundId: 'custom',
      customSoundDataUrl: dataUrl,
    };
    saveChatNotificationSettings(this.soundSettings);
    this.chatNotify.playIncomingSound();
    this.toast.success('Tono personalizado guardado.');
  }

  testSound(): void {
    this.chatNotify.playIncomingSound();
  }

  async setMode(next: ChatMode): Promise<void> {
    if (this.mode === next) return;
    this.mode = next;
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
    await this.reloadPrivate();
  }

  async reload(quiet = false): Promise<void> {
    if (this.mode === 'global') {
      await this.reloadGlobal(quiet);
    } else {
      if (!this.selectedPeerId && this.contacts.length) {
        this.selectedPeerId = this.contacts[0].userId;
      }
      await this.reloadPrivate(quiet);
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
