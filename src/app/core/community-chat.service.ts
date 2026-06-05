import { Injectable, NgZone } from '@angular/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { AuthService } from './auth.service';

export interface CommunityMessage {
  id: string;
  userId: string;
  authorEmail: string;
  body: string;
  createdAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class CommunityChatService {
  private channel: RealtimeChannel | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {}

  async fetchMessages(limit = 80): Promise<{ rows: CommunityMessage[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('community_messages')
      .select('id, user_id, author_email, body, created_at')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      return { rows: [], error: error.message };
    }
    const rows = (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>));
    return { rows, error: null };
  }

  async sendMessage(body: string, authorEmail: string): Promise<{ error: string | null }> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) {
      return { error: 'Iniciá sesión para enviar mensajes.' };
    }
    const text = body.trim();
    if (!text) {
      return { error: 'Escribí un mensaje.' };
    }
    if (text.length > 2000) {
      return { error: 'El mensaje es demasiado largo (máx. 2000 caracteres).' };
    }
    const { error } = await this.auth.client.from('community_messages').insert({
      user_id: uid,
      author_email: (authorEmail || session.user.email || 'usuario').trim().toLowerCase(),
      body: text,
    });
    return { error: error?.message ?? null };
  }

  async deleteMessage(id: string): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('community_messages').delete().eq('id', id);
    return { error: error?.message ?? null };
  }

  subscribeNewMessages(onInsert: () => void): void {
    this.unsubscribe();
    this.channel = this.auth.client
      .channel('community_messages_live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'community_messages' },
        () => {
          this.zone.run(() => onInsert());
        }
      )
      .subscribe();
  }

  unsubscribe(): void {
    if (this.channel) {
      void this.auth.client.removeChannel(this.channel);
      this.channel = null;
    }
  }

  private mapRow(r: Record<string, unknown>): CommunityMessage {
    return {
      id: r['id'] as string,
      userId: r['user_id'] as string,
      authorEmail: String(r['author_email'] ?? ''),
      body: String(r['body'] ?? ''),
      createdAt: r['created_at'] as string,
    };
  }
}
