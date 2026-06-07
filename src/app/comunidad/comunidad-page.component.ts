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
import { ChatUnreadService } from '../core/chat-unread.service';
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
import { environment } from '../../environments/environment';

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
  pushDiagLabel = '';
  pushDiagLines: string[] = [];
  /** FCM registrado en servidor para el usuario logueado (no solo permiso del navegador). */
  pushRegisteredForUser = false;
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
    private readonly chatUnread: ChatUnreadService,
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
    await this.refreshPushDiagnostics();
    void this.chatRealtime.start();
    this.uiSubs.push(
      this.chatRealtime.global$.subscribe((msg) => {
        if (this.mode === 'global') void this.reloadGlobal(true);
      }),
      this.chatRealtime.private$.subscribe((msg) => {
        void this.loadContacts(true);
        if (this.mode === 'private' && this.selectedPeerId === msg.senderId) {
          // Con el chat abierto: marcar leído al instante para que el otro vea ✓✓ Leído.
          void this.directChat.markReadFromPeer(msg.senderId).then(() => void this.reloadPrivate(true));
        }
      }),
      this.chatRealtime.privateStatus$.subscribe(() => {
        if (this.mode === 'private' && this.selectedPeerId) {
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

  async refreshPushDiagnostics(): Promise<void> {
    const ui = await this.webPush.getUiState();
    const vapidOk =
      typeof environment.vapidPublicKey === 'string' && environment.vapidPublicKey.trim().length > 0;
    const parts: string[] = [];
    if (this.notifyPermission === 'granted') parts.push('Navegador: permitido');
    else if (this.notifyPermission === 'denied') parts.push('Navegador: bloqueado');
    else if (this.notifyPermission === 'unsupported') parts.push('Navegador: no soportado');
    else parts.push('Navegador: sin permiso');
    if (!vapidOk) parts.push('FCM: falta VAPID en Vercel');
    else if (ui === 'active') parts.push('FCM: suscrito en este celular');
    else if (ui === 'unsupported') parts.push('FCM: SW inactivo (usá la app publicada en HTTPS)');
    else parts.push('FCM: sin suscripción — tocá Activar avisos');

    if (this.myUserId) {
      const { count } = await this.auth.client
        .from('push_subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', this.myUserId);
      const n = count ?? 0;
      this.pushRegisteredForUser = n > 0;
      parts.push(n > 0 ? `Servidor: ${n} dispositivo(s) registrado(s)` : 'Servidor: sin registro push');
    } else {
      this.pushRegisteredForUser = false;
    }
    this.pushDiagLabel = parts.join(' · ');
    this.pushDiagLines = await this.webPush.getDiagnostics(this.myUserId);
  }

  async testLocalNotification(): Promise<void> {
    const msg = this.webPush.tryLocalNotification();
    this.pushUiState = msg;
    this.toast.show(msg, 'info');
  }

  async testClosedAppPush(): Promise<void> {
    const push = await this.webPush.sendTestPush();
    this.pushUiState = push.message;
    await this.refreshPushDiagnostics();
    if (push.ok) {
      this.toast.success(push.message);
    } else {
      this.toast.show(push.message, 'info');
    }
  }

  async enableAlerts(): Promise<void> {
    const push = await this.webPush.subscribeBackgroundAlerts();
    this.pushUiState = push.message;
    this.notifyPermission =
      typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    await this.refreshPushDiagnostics();
    if (push.ok) {
      const local = this.webPush.tryLocalNotification();
      this.pushUiState = `${push.message} | ${local}`;
      this.toast.success(
        'FCM activo. Si viste la notificación local arriba, el permiso OK. Ahora "Probar con app cerrada".'
      );
      this.chatNotify.playIncomingSound();
    } else if (this.notifyPermission === 'denied') {
      this.toast.show(
        'Permiso bloqueado. Android: Ajustes → Apps → Chrome → Notificaciones → Activar.',
        'info'
      );
    } else {
      this.toast.show(push.message, 'info');
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
    const loaded = await readCustomSoundFile(file);
    if (!loaded) {
      this.toast.show(
        'Archivo no válido o muy pesado (máx. ~2,5 MB). Elegí mp3/m4a del celular; conviene un fragmento corto.',
        'info'
      );
      return;
    }
    try {
      this.soundSettings = {
        soundId: 'custom',
        customSoundDataUrl: loaded.dataUrl,
        customSoundFileName: loaded.fileName,
      };
      saveChatNotificationSettings(this.soundSettings);
    } catch {
      this.toast.show('No se pudo guardar (archivo muy largo). Probá un tono de menos de 30 segundos.', 'info');
      return;
    }
    this.chatNotify.playIncomingSound();
    this.toast.success(`Tono guardado: ${loaded.fileName}`);
  }

  testSound(): void {
    this.chatNotify.playIncomingSound();
  }

  async setMode(next: ChatMode): Promise<void> {
    if (this.mode === next) return;
    this.mode = next;
    await this.reload();
  }

  async loadContacts(quiet = false): Promise<void> {
    if (!quiet) this.loadingContacts = true;
    const { rows, error } = await this.directChat.fetchContacts();
    if (!quiet) this.loadingContacts = false;
    if (error) {
      const hint =
        error.includes('list_chat_contacts') || error.includes('private_messages')
          ? ' Ejecutá 052 y 055_chat_contacts_unread.sql en Supabase.'
          : '';
      if (this.mode === 'private' && !this.loadError) {
        this.loadError = `${error}${hint}`;
      }
      return;
    }
    this.contacts = rows;
    this.chatUnread.setTotal(rows.reduce((s, c) => s + c.unreadCount, 0));
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
      const hint =
        error.includes('private_messages') || error.includes('delivered_at')
          ? ' Ejecutá 052 y 054_private_messages_receipts.sql en Supabase.'
          : '';
      this.loadError = `${error}${hint}`;
      return;
    }
    this.privateMessages = rows;
    this.scrollPending = true;
    await this.directChat.markReadFromPeer(this.selectedPeerId);
    const refresh = await this.directChat.fetchConversation(this.selectedPeerId, 150);
    if (!refresh.error) {
      this.privateMessages = refresh.rows;
    }
    await this.loadContacts(true);
  }

  deliveryLabel(m: PrivateMessage): string {
    const s = this.directChat.deliveryStatus(m, this.myUserId);
    if (s === 'read') return 'Leído';
    if (s === 'delivered') return 'Entregado';
    return 'Enviado';
  }

  isDeliveryRead(m: PrivateMessage): boolean {
    return this.directChat.deliveryStatus(m, this.myUserId) === 'read';
  }

  isDeliveryDelivered(m: PrivateMessage): boolean {
    const s = this.directChat.deliveryStatus(m, this.myUserId);
    return s === 'delivered' || s === 'read';
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
