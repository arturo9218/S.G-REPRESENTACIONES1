import { Injectable, NgZone } from '@angular/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { AuthService } from './auth.service';

export interface ChatContact {
  userId: string;
  email: string;
  unreadCount: number;
}

export type PrivateDeliveryStatus = 'sent' | 'delivered' | 'read';

export interface PrivateMessage {
  id: string;
  senderId: string;
  recipientId: string;
  senderEmail: string;
  body: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class DirectMessageService {
  private syncChannel: RealtimeChannel | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {}

  async fetchContacts(): Promise<{ rows: ChatContact[]; error: string | null }> {
    const { data, error } = await this.auth.client.rpc('list_chat_contacts');
    if (error) {
      return { rows: [], error: error.message };
    }
    const unreadFallback = await this.fetchUnreadCountsBySender();
    const rows = (data ?? []).map((r: Record<string, unknown>) => {
      const userId = r['user_id'] as string;
      const fromRpc = Number(r['unread_count']);
      const unreadCount =
        Number.isFinite(fromRpc) && fromRpc > 0
          ? fromRpc
          : unreadFallback.get(userId) ?? 0;
      return {
        userId,
        email: String(r['email'] ?? '').trim().toLowerCase(),
        unreadCount,
      };
    });
    return { rows, error: null };
  }

  /** Si falta 055 en Supabase, cuenta no leídos directo desde private_messages. */
  private async fetchUnreadCountsBySender(): Promise<Map<string, number>> {
    const session = await this.auth.getSession();
    const me = session?.user?.id;
    if (!me) return new Map();

    const { data, error } = await this.auth.client
      .from('private_messages')
      .select('sender_id')
      .eq('recipient_id', me)
      .is('read_at', null);

    if (error) return new Map();
    const map = new Map<string, number>();
    for (const row of data ?? []) {
      const senderId = String(row['sender_id'] ?? '');
      if (!senderId) continue;
      map.set(senderId, (map.get(senderId) ?? 0) + 1);
    }
    return map;
  }

  async fetchConversation(
    peerId: string,
    limit = 120
  ): Promise<{ rows: PrivateMessage[]; error: string | null }> {
    const session = await this.auth.getSession();
    const me = session?.user?.id;
    if (!me) return { rows: [], error: 'Iniciá sesión.' };

    const { data, error } = await this.auth.client
      .from('private_messages')
      .select(
        'id, sender_id, recipient_id, sender_email, body, created_at, delivered_at, read_at'
      )
      .or(
        `and(sender_id.eq.${me},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${me})`
      )
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) return { rows: [], error: error.message };
    return { rows: (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>)), error: null };
  }

  async sendMessage(
    recipientId: string,
    body: string,
    senderEmail: string
  ): Promise<{ error: string | null }> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return { error: 'Iniciá sesión.' };
    if (recipientId === uid) return { error: 'No podés enviarte mensajes a vos mismo.' };

    const text = body.trim();
    if (!text) return { error: 'Escribí un mensaje.' };
    if (text.length > 2000) return { error: 'Máximo 2000 caracteres.' };

    const { error } = await this.auth.client.from('private_messages').insert({
      sender_id: uid,
      recipient_id: recipientId,
      sender_email: (senderEmail || session.user.email || 'usuario').trim().toLowerCase(),
      body: text,
    });
    return { error: error?.message ?? null };
  }

  async deleteMessage(id: string): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('private_messages').delete().eq('id', id);
    return { error: error?.message ?? null };
  }

  /** El destinatario confirma que recibió los mensajes de ese contacto. */
  async markDeliveredFromPeer(peerId: string): Promise<void> {
    await this.auth.client.rpc('mark_private_messages_delivered', { p_sender_id: peerId });
  }

  /** El destinatario confirma lectura al ver el chat. */
  async markReadFromPeer(peerId: string): Promise<void> {
    await this.auth.client.rpc('mark_private_messages_read', { p_sender_id: peerId });
  }

  deliveryStatus(msg: PrivateMessage, myUserId: string): PrivateDeliveryStatus {
    if (msg.senderId !== myUserId) return 'sent';
    if (msg.readAt) return 'read';
    if (msg.deliveredAt) return 'delivered';
    return 'sent';
  }

  subscribePrivateSync(
    myUserId: string,
    handlers: {
      onIncoming: (msg: PrivateMessage) => void;
      onStatusChange: () => void;
    }
  ): void {
    this.unsubscribe();
    this.syncChannel = this.auth.client
      .channel(`private_messages_sync_${myUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'private_messages',
          filter: `recipient_id=eq.${myUserId}`,
        },
        (payload) => {
          const msg = this.mapRow(payload.new as Record<string, unknown>);
          this.zone.run(() => {
            void this.markDeliveredFromPeer(msg.senderId).then(() => handlers.onIncoming(msg));
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'private_messages',
          filter: `sender_id=eq.${myUserId}`,
        },
        () => {
          this.zone.run(() => handlers.onStatusChange());
        }
      )
      .subscribe();
  }

  /** @deprecated Usar subscribePrivateSync */
  subscribeIncoming(myUserId: string, onInsert: (msg: PrivateMessage) => void): void {
    this.subscribePrivateSync(myUserId, { onIncoming: onInsert, onStatusChange: () => {} });
  }

  unsubscribe(): void {
    if (this.syncChannel) {
      void this.auth.client.removeChannel(this.syncChannel);
      this.syncChannel = null;
    }
  }

  private mapRow(r: Record<string, unknown>): PrivateMessage {
    return {
      id: r['id'] as string,
      senderId: r['sender_id'] as string,
      recipientId: r['recipient_id'] as string,
      senderEmail: String(r['sender_email'] ?? ''),
      body: String(r['body'] ?? ''),
      createdAt: r['created_at'] as string,
      deliveredAt: (r['delivered_at'] as string) ?? null,
      readAt: (r['read_at'] as string) ?? null,
    };
  }
}
