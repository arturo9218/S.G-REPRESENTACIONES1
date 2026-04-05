import webPush from 'npm:web-push@3.6.7';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface PushPayload {
  title: string;
  body: string;
  /** Metadatos (type, deviceId, …); se fusionan con onActionClick para el SW de Angular */
  data?: Record<string, string>;
  /** Agrupa/sustituye notificaciones del mismo tag en el sistema */
  tag?: string;
  /** Ruta relativa al origen (ej. /alertas?deviceId=…). El SW de Angular usa data.onActionClick */
  navigate?: string;
  /** Prioriza la alerta en el sistema (recomendado para alarmas) */
  requireInteraction?: boolean;
}

/** TTL del mensaje en la red push (segundos). Antes 120s: en segundo plano a veces expiraba antes de entregar. */
const PUSH_TTL_SECONDS = 86_400;

/**
 * URL pública del front (HTTPS, sin barra final), ej. https://tu-app.vercel.app
 * Secret en Supabase: APP_PUBLIC_URL — para icon/badge absolutos en Android/Chrome en segundo plano.
 */
function notificationBaseUrl(): string | undefined {
  const u = Deno.env.get('APP_PUBLIC_URL')?.trim().replace(/\/$/, '');
  return u || undefined;
}

export async function sendPushToUser(
  supabase: SupabaseClient,
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; skipped?: string; lastError?: string }> {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')?.trim();
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')?.trim();
  const subject = Deno.env.get('VAPID_SUBJECT')?.trim() ?? 'mailto:noreply@example.com';
  if (!publicKey || !privateKey) {
    console.warn('[send-web-push] VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY faltan en secrets de la función');
    return { sent: 0, skipped: 'vapid_not_configured' };
  }

  webPush.setVapidDetails(subject, publicKey, privateKey);

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (error || !subs?.length) {
    const sk = error?.message ?? 'no_subscriptions';
    if (sk === 'no_subscriptions') {
      console.warn('[send-web-push] Sin filas en push_subscriptions para user_id=', userId);
    } else {
      console.warn('[send-web-push] Error leyendo suscripciones:', sk);
    }
    return { sent: 0, skipped: sk };
  }

  // Formato que espera @angular/service-worker (ngsw-worker.js → handlePush).
  // icon/badge absolutos + vibrate/renotify ayudan a que el SO muestre aviso con app en segundo plano.
  const base = notificationBaseUrl();
  const notif: Record<string, unknown> = {
    title: payload.title,
    body: payload.body,
    vibrate: [200, 100, 200],
    renotify: Boolean(payload.tag),
    silent: false,
    /** Pide tono por defecto del canal (Android/Chrome; requiere ngsw parcheado con "sound" en NOTIFICATION_OPTION_NAMES). */
    sound: 'default',
    requireInteraction: payload.requireInteraction !== false,
  };
  if (payload.tag) {
    notif.tag = payload.tag;
  }
  if (base) {
    notif.icon = `${base}/assets/icons/icon-192.svg`;
    notif.badge = `${base}/favicon.ico`;
  }
  const dataMerged: Record<string, unknown> = {};
  if (payload.data && Object.keys(payload.data).length) {
    for (const [k, v] of Object.entries(payload.data)) {
      dataMerged[k] = v;
    }
  }
  if (payload.navigate?.trim()) {
    const url = payload.navigate.trim().startsWith('/')
      ? payload.navigate.trim()
      : `/${payload.navigate.trim()}`;
    dataMerged.onActionClick = {
      default: {
        operation: 'navigateLastFocusedOrOpen',
        url,
      },
    };
  }
  if (Object.keys(dataMerged).length) {
    notif.data = dataMerged;
  }

  const body = JSON.stringify({
    notification: notif,
    data: payload.data ?? {},
  });

  let sent = 0;
  let lastError = '';
  for (const s of subs) {
    try {
      await webPush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        },
        body,
        { TTL: PUSH_TTL_SECONDS }
      );
      sent++;
    } catch (e: unknown) {
      const status = (e as { statusCode?: number })?.statusCode;
      const errBody = (e as { body?: string })?.body ?? '';
      lastError = `http_${status ?? 'unknown'}${errBody ? ` ${errBody.slice(0, 120)}` : ''}`;
      console.warn('[send-web-push] sendNotification falló:', lastError);
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
    }
  }
  if (sent === 0 && subs.length && !lastError) {
    lastError = 'all_endpoints_failed';
  }
  return { sent, lastError: lastError || undefined };
}
