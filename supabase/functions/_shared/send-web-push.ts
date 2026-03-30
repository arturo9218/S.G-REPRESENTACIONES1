import webPush from 'npm:web-push@3.6.7';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Agrupa/sustituye notificaciones del mismo tag en el sistema */
  tag?: string;
}

export async function sendPushToUser(
  supabase: SupabaseClient,
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; skipped?: string }> {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')?.trim();
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')?.trim();
  const subject = Deno.env.get('VAPID_SUBJECT')?.trim() ?? 'mailto:noreply@example.com';
  if (!publicKey || !privateKey) {
    return { sent: 0, skipped: 'vapid_not_configured' };
  }

  webPush.setVapidDetails(subject, publicKey, privateKey);

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (error || !subs?.length) {
    return { sent: 0, skipped: error?.message ?? 'no_subscriptions' };
  }

  // Formato que espera @angular/service-worker (ngsw-worker.js → handlePush).
  const notif: Record<string, string> = {
    title: payload.title,
    body: payload.body,
  };
  if (payload.tag) {
    notif.tag = payload.tag;
  }

  const body = JSON.stringify({
    notification: notif,
    data: payload.data ?? {},
  });

  let sent = 0;
  for (const s of subs) {
    try {
      await webPush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        },
        body,
        { TTL: 120 }
      );
      sent++;
    } catch (e: unknown) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
    }
  }
  return { sent };
}
