// Supabase Edge Function: ingest-reading
// Recibe telemetría de ESP8266 y guarda en device_readings.
// Deploy:
// supabase functions deploy ingest-reading --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPushToUser } from '../_shared/send-web-push.ts';
import { formatEsArDateTime } from '../_shared/format-datetime.ts';

const TEMP_PUSH_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_TEMP_PUSH_COOLDOWN_MS = 60 * 1000;

interface IngestPayload {
  moduleId: string;
  deviceToken: string;
  sentAt?: string;
  temp1_c: number;
  temp2_c?: number | null;
  temp3_c?: number | null;
  /** Corriente RMS (A), ej. SCT-013 */
  current_a?: number | null;
  power_w?: number | null;
  press1_bar?: number | null;
  press2_bar?: number | null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const raw = (await req.json()) as IngestPayload;
    const moduleId = typeof raw.moduleId === 'string' ? raw.moduleId.trim() : '';
    const deviceToken =
      typeof raw.deviceToken === 'string' ? raw.deviceToken.trim() : '';
    const payload: IngestPayload = {
      ...raw,
      moduleId,
      deviceToken,
    };

    if (!moduleId || !deviceToken || Number.isNaN(payload.temp1_c)) {
      return new Response(JSON.stringify({ error: 'Payload inválido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Faltan variables SUPABASE_URL/SERVICE_ROLE_KEY' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(url, serviceKey);

    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('id, device_token_hash, active, owner_user_id, name, sensor_1_label')
      .eq('module_id', moduleId)
      .single();

    if (devErr || !device) {
      return new Response(JSON.stringify({ error: 'Dispositivo no encontrado' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!device.active) {
      return new Response(JSON.stringify({ error: 'Dispositivo inactivo' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // En producción, comparar hash seguro (bcrypt/argon) y no texto plano.
    if (device.device_token_hash !== deviceToken) {
      return new Response(JSON.stringify({ error: 'Token inválido' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: th } = await supabase
      .from('device_thresholds')
      .select(
        'notifications_enabled, temp1_min_c, temp1_max_c, temp_push_cooldown_ms, last_push_temp_breach_at, temp1_offset_c, temp2_offset_c, temp3_offset_c'
      )
      .eq('device_id', device.id)
      .maybeSingle();

    const num = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const o1 = num(th?.temp1_offset_c);
    const o2 = num(th?.temp2_offset_c);
    const o3 = num(th?.temp3_offset_c);

    const temp1Corrected = payload.temp1_c + o1;
    const temp2Corrected =
      payload.temp2_c == null || Number.isNaN(payload.temp2_c as number)
        ? null
        : (payload.temp2_c as number) + o2;
    const temp3Corrected =
      payload.temp3_c == null || Number.isNaN(payload.temp3_c as number)
        ? null
        : (payload.temp3_c as number) + o3;

    const { error: insErr } = await supabase.from('device_readings').insert({
      device_id: device.id,
      created_at: payload.sentAt ?? new Date().toISOString(),
      temp1_raw_c: payload.temp1_c,
      temp2_raw_c:
        payload.temp2_c == null || Number.isNaN(payload.temp2_c as number)
          ? null
          : (payload.temp2_c as number),
      temp3_raw_c:
        payload.temp3_c == null || Number.isNaN(payload.temp3_c as number)
          ? null
          : (payload.temp3_c as number),
      temp1_c: temp1Corrected,
      temp2_c: temp2Corrected,
      temp3_c: temp3Corrected,
      current_a: payload.current_a ?? null,
      power_w: payload.power_w ?? null,
      press1_bar: payload.press1_bar ?? null,
      press2_bar: payload.press2_bar ?? null,
    });

    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    /** Diagnóstico push (útil si no llegan notificaciones); no afecta al ESP. */
    let pushDiag: { sent: number; skipped?: string; lastError?: string } | undefined;

    if (th?.notifications_enabled) {
      const t = temp1Corrected;
      const sensorLabel =
        typeof device.sensor_1_label === 'string' && device.sensor_1_label.trim()
          ? device.sensor_1_label.trim()
          : 'Cámara 1';
      let breach = false;
      let msg = '';
      if (th.temp1_min_c != null && t < th.temp1_min_c) {
        breach = true;
        msg = `${sensorLabel}: ${t.toFixed(1)} °C, por debajo del mínimo configurado (${th.temp1_min_c} °C).`;
      }
      if (th.temp1_max_c != null && t > th.temp1_max_c) {
        breach = true;
        msg = `${sensorLabel}: ${t.toFixed(1)} °C, por encima del máximo configurado (${th.temp1_max_c} °C).`;
      }
      if (breach && device.owner_user_id) {
        const lastMs = th.last_push_temp_breach_at
          ? new Date(th.last_push_temp_breach_at).getTime()
          : null;
        const configuredCooldown =
          typeof th.temp_push_cooldown_ms === 'number' &&
          Number.isFinite(th.temp_push_cooldown_ms)
            ? Math.max(MIN_TEMP_PUSH_COOLDOWN_MS, Math.round(th.temp_push_cooldown_ms))
            : TEMP_PUSH_COOLDOWN_MS;
        const now = Date.now();
        // Antes: last=0 si null ⇒ Date.now()-0 siempre > cooldown ⇒ reintento cada lectura.
        if (lastMs != null && now - lastMs <= configuredCooldown) {
          // Aún en retardo respecto al último aviso (o intento).
        } else {
          const deviceName = typeof device.name === 'string' ? device.name : 'Dispositivo';
          const when = formatEsArDateTime(new Date());
          const pushResult = await sendPushToUser(supabase, device.owner_user_id, {
            title: `${deviceName} · ${sensorLabel}: superó el umbral`,
            body: `${msg}\nDetectado: ${when}`,
            data: { type: 'temp_breach', deviceId: device.id },
            tag: `temp-${device.id}`,
            navigate: `/alertas?deviceId=${encodeURIComponent(device.id)}`,
            requireInteraction: true,
          });
          pushDiag = {
            sent: pushResult.sent,
            skipped: pushResult.skipped,
            lastError: pushResult.lastError,
          };
          // Siempre marcar último intento para respetar el retardo aunque falle Web Push (VAPID, sin suscripción, etc.).
          await supabase
            .from('device_thresholds')
            .update({ last_push_temp_breach_at: new Date().toISOString() })
            .eq('device_id', device.id);
          const { error: alarmInsErr } = await supabase.from('device_alarm_events').insert({
            device_id: device.id,
            owner_user_id: device.owner_user_id,
            triggered_at: new Date().toISOString(),
            kind: 'temp_breach',
            message: msg,
            detail: null,
            temp1_c: t,
          });
          if (alarmInsErr) {
            console.warn('[ingest-reading] device_alarm_events:', alarmInsErr.message);
          }
          if (pushResult.sent === 0) {
            console.warn('[ingest-reading] alarma temp sin push entregado:', pushResult);
          }
        }
      }
    }

    return new Response(JSON.stringify(pushDiag ? { ok: true, push: pushDiag } : { ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
