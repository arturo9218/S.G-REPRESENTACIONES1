import { Injectable, NgZone } from '@angular/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { AuthService } from './auth.service';

export interface ChatContact {
  userId: string;
  email: string;
}

export interface PrivateMessage {
  id: string;
  senderId: string;
  recipientId: string;
  senderEmail: string;
  body: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class DirectMessageService {
  private channel: RealtimeChannel | null = null;
  private watchPeerId: string | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {}

  async fetchContacts(): Promise<{ rows: ChatContact[]; error: string | null }> {
    const { data, error } = await this.auth.client.rpc('list_chat_contacts');
    if (error) {
      return { rows: [], error: error.message };
    }
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      userId: r['user_id'] as string,
      email: String(r['email'] ?? '').trim().toLowerCase(),
    }));
    return { rows, error: null };
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
      .select('id, sender_id, recipient_id, sender_email, body, created_at')
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

  subscribeConversation(peerId: string, myUserId: string, onChange: () => void): void {
    this.unsubscribe();
    this.watchPeerId = peerId;
    this.channel = this.auth.client
      .channel(`private_messages_${myUserId}_${peerId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'private_messages',
          filter: `recipient_id=eq.${myUserId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const sender = row['sender_id'] as string;
          if (sender === peerId) {
            this.zone.run(() => onChange());
          }
        }
      )
      .subscribe();
  }

  unsubscribe(): void {
    this.watchPeerId = null;
    if (this.channel) {
      void this.auth.client.removeChannel(this.channel);
      this.channel = null;
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
    };
  }
}
