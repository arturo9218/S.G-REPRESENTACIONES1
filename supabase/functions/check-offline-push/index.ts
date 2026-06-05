// Invocar cada 5–10 min desde un cron externo (ej. cron-job.org) o Supabase Schedules.
// POST con header: x-alert-cron-secret: <mismo valor que secret ALERT_CRON_SECRET>
// Deploy: supabase functions deploy check-offline-push --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPushToOwnerAndAdmins } from '../_shared/send-web-push.ts';
import { formatEsArDateTime } from '../_shared/format-datetime.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-alert-cron-secret',
};

/** Sin lecturas nuevas por este tiempo ⇒ se considera desconectado para el push. */
const OFFLINE_AFTER_MS = 10 * 60 * 1000;
const MIN_PUSH_COOLDOWN_MS = 60 * 1000;
const DEFAULT_PUSH_COOLDOWN_MS = 15 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const secret = Deno.env.get('ALERT_CRON_SECRET')?.trim();
  const headerSecret = req.headers.get('x-alert-cron-secret')?.trim();
  if (!secret || headerSecret !== secret) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Faltan variables de Supabase' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(url, serviceKey);

  const { data: lastRows, error: rpcErr } = await supabase.rpc(
    'internal_last_reading_per_device'
  );
  if (rpcErr) {
    return new Response(JSON.stringify({ error: rpcErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const lastByDevice = new Map<string, number>();
  for (const row of lastRows ?? []) {
    const id = row.device_id as string;
    const ts = row.last_at ? new Date(row.last_at as string).getTime() : 0;
    if (id && ts) lastByDevice.set(id, ts);
  }

  const { data: devs, error: devErr } = await supabase
    .from('devices')
    .select(
      'id, owner_user_id, name, device_thresholds(notifications_enabled, last_push_offline_at, temp_push_cooldown_ms, offline_push_cooldown_ms)'
    )
    .eq('active', true);

  if (devErr) {
    return new Response(JSON.stringify({ error: devErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const now = Date.now();
  let offlinePushes = 0;

  for (const d of devs ?? []) {
    const rawTh = d.device_thresholds as
      | {
          notifications_enabled?: boolean;
          last_push_offline_at?: string | null;
          temp_push_cooldown_ms?: number | null;
          offline_push_cooldown_ms?: number | null;
        }
      | {
          notifications_enabled?: boolean;
          last_push_offline_at?: string | null;
          temp_push_cooldown_ms?: number | null;
          offline_push_cooldown_ms?: number | null;
        }[]
      | null;
    const th = Array.isArray(rawTh) ? rawTh[0] : rawTh;
    if (!th?.notifications_enabled || !d.owner_user_id) continue;

    const offlineRaw = th.offline_push_cooldown_ms;
    const tempRaw = th.temp_push_cooldown_ms;
    const chosenMs =
      typeof offlineRaw === 'number' && Number.isFinite(offlineRaw) && offlineRaw > 0
        ? offlineRaw
        : typeof tempRaw === 'number' && Number.isFinite(tempRaw) && tempRaw > 0
          ? tempRaw
          : null;
    const offlinePushCooldownMs =
      chosenMs != null
        ? Math.max(MIN_PUSH_COOLDOWN_MS, Math.round(chosenMs))
        : DEFAULT_PUSH_COOLDOWN_MS;

    const lastAt = lastByDevice.get(d.id);
    if (lastAt == null) continue;

    if (now - lastAt <= OFFLINE_AFTER_MS) continue;

    const lastPushMs = th.last_push_offline_at
      ? new Date(th.last_push_offline_at).getTime()
      : null;
    // Antes: lastPush=0 si null ⇒ now-0 > cooldown siempre ⇒ reintento cada cron.
    if (lastPushMs != null && now - lastPushMs <= offlinePushCooldownMs) continue;

    const name = typeof d.name === 'string' ? d.name : 'Dispositivo';
    const lastReadingAt = new Date(lastAt);
    const avisoAt = new Date(now);
    const r = await sendPushToOwnerAndAdmins(supabase, d.owner_user_id as string, {
      title: `${name}: dispositivo desconectado`,
      body:
        `Sin lecturas nuevas. Última lectura: ${formatEsArDateTime(lastReadingAt)}. ` +
        `Aviso: ${formatEsArDateTime(avisoAt)}.`,
      data: { type: 'offline', deviceId: d.id },
      tag: `offline-${d.id}`,
      navigate: `/alertas?deviceId=${encodeURIComponent(d.id as string)}`,
      requireInteraction: true,
    });
    offlinePushes += r.sent;
    if (r.sent > 0) {
      await supabase
        .from('device_thresholds')
        .update({ last_push_offline_at: new Date().toISOString() })
        .eq('device_id', d.id);
      const bodyText =
        `Sin lecturas nuevas. Última lectura: ${formatEsArDateTime(lastReadingAt)}. ` +
        `Aviso: ${formatEsArDateTime(avisoAt)}.`;
      const { error: alarmInsErr } = await supabase.from('device_alarm_events').insert({
        device_id: d.id,
        owner_user_id: d.owner_user_id as string,
        triggered_at: new Date().toISOString(),
        kind: 'offline',
        message: `${name}: dispositivo desconectado`,
        detail: bodyText,
        temp1_c: null,
      });
      if (alarmInsErr) {
        console.warn('[check-offline-push] device_alarm_events:', alarmInsErr.message);
      }
    } else {
      console.warn('[check-offline-push] offline push no entregado:', d.id, r);
    }
  }

  return new Response(JSON.stringify({ ok: true, offlinePushes }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
