// Supabase Edge Function: ingest-reading
// Recibe telemetría de ESP8266 y guarda en device_readings.
// Deploy:
// supabase functions deploy ingest-reading --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPushToOwnerAndAdmins } from '../_shared/send-web-push.ts';
import { formatEsArDateTime } from '../_shared/format-datetime.ts';

const TEMP_PUSH_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_TEMP_PUSH_COOLDOWN_MS = 60 * 1000;
/** Entre avisos mientras la temperatura sigue fuera de umbral (tras el 1er aviso del episodio). */
const REPEAT_TEMP_BREACH_MS = 60 * 1000;

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
      .select('id, device_token_hash, active, owner_user_id, name, sensor_1_label, sensor_2_label')
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

    /** `select('*')`: si falta una migración SQL, no rompe la lectura de umbrales (columnas opcionales). */
    const { data: th, error: thErr } = await supabase
      .from('device_thresholds')
      .select('*')
      .eq('device_id', device.id)
      .maybeSingle();
    if (thErr) {
      console.warn('[ingest-reading] device_thresholds:', thErr.message);
    }

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

    if (th?.notifications_enabled && device.owner_user_id) {
      const sensor1Label =
        typeof device.sensor_1_label === 'string' && device.sensor_1_label.trim()
          ? device.sensor_1_label.trim()
          : 'Sensor 1';
      const sensor2Label =
        typeof device.sensor_2_label === 'string' && device.sensor_2_label.trim()
          ? device.sensor_2_label.trim()
          : 'Sensor 2';

      const t1 = temp1Corrected;
      const tempMsgs: string[] = [];
      if (th.temp1_min_c != null && t1 < th.temp1_min_c) {
        tempMsgs.push(
          `${sensor1Label}: ${t1.toFixed(1)} °C, por debajo del mínimo configurado (${th.temp1_min_c} °C).`
        );
      }
      if (th.temp1_max_c != null && t1 > th.temp1_max_c) {
        tempMsgs.push(
          `${sensor1Label}: ${t1.toFixed(1)} °C, por encima del máximo configurado (${th.temp1_max_c} °C).`
        );
      }
      if (temp2Corrected != null) {
        const t2 = temp2Corrected;
        if (th.temp2_min_c != null && t2 < th.temp2_min_c) {
          tempMsgs.push(
            `${sensor2Label}: ${t2.toFixed(1)} °C, por debajo del mínimo configurado (${th.temp2_min_c} °C).`
          );
        }
        if (th.temp2_max_c != null && t2 > th.temp2_max_c) {
          tempMsgs.push(
            `${sensor2Label}: ${t2.toFixed(1)} °C, por encima del máximo configurado (${th.temp2_max_c} °C).`
          );
        }
      }

      /** Umbral de corriente: solo con `current_a` del ESP (SCT); no estimar desde W en la nube. */
      const currentA: number | null =
        payload.current_a != null && Number.isFinite(payload.current_a as number)
          ? (payload.current_a as number)
          : null;
      let currentMsg = '';
      let currentBreach = false;
      const maxA = (th as Record<string, unknown>)['current_max_a'];
      if (
        currentA != null &&
        maxA != null &&
        typeof maxA === 'number' &&
        Number.isFinite(maxA) &&
        currentA > maxA
      ) {
        currentBreach = true;
        currentMsg = `Corriente: ${currentA.toFixed(2)} A supera el máximo configurado (${maxA.toFixed(2)} A).`;
      }

      const tempBreach = tempMsgs.length > 0;
      const configuredCooldown =
        typeof th.temp_push_cooldown_ms === 'number' && Number.isFinite(th.temp_push_cooldown_ms)
          ? Math.max(MIN_TEMP_PUSH_COOLDOWN_MS, Math.round(th.temp_push_cooldown_ms))
          : TEMP_PUSH_COOLDOWN_MS;
      const now = Date.now();

      /** Temperatura volvió a rango: se resetea el episodio; el próximo fallo vuelve a exigir el retardo completo. */
      if (!tempBreach) {
        const tr = th as Record<string, unknown>;
        const ep = tr['temp_breach_episode_started_at'];
        if (typeof ep === 'string' || th.last_push_temp_breach_at) {
          await supabase
            .from('device_thresholds')
            .update({
              temp_breach_episode_started_at: null,
              last_push_temp_breach_at: null,
            })
            .eq('device_id', device.id);
        }
      }

      let shouldSendTemp = false;
      if (tempBreach) {
        const tr = th as Record<string, unknown>;
        const episodeRaw = tr['temp_breach_episode_started_at'];
        let episodeStartMs =
          typeof episodeRaw === 'string' ? new Date(episodeRaw).getTime() : null;

        if (episodeStartMs == null) {
          const t0 = new Date().toISOString();
          await supabase
            .from('device_thresholds')
            .update({ temp_breach_episode_started_at: t0 })
            .eq('device_id', device.id);
          episodeStartMs = now;
        }

        const lastTempMs = th.last_push_temp_breach_at
          ? new Date(th.last_push_temp_breach_at).getTime()
          : null;

        if (lastTempMs == null) {
          shouldSendTemp = now - episodeStartMs >= configuredCooldown;
        } else {
          shouldSendTemp = now - lastTempMs >= REPEAT_TEMP_BREACH_MS;
        }
      }

      const lastCurrentRaw = (th as Record<string, unknown>)['last_push_current_breach_at'];
      const lastCurrentMs =
        typeof lastCurrentRaw === 'string' ? new Date(lastCurrentRaw).getTime() : null;
      const currentCooldownOk = lastCurrentMs == null || now - lastCurrentMs > configuredCooldown;

      const shouldSendCurr = currentBreach && currentCooldownOk;
      const deviceName = typeof device.name === 'string' ? device.name : 'Dispositivo';
      const when = formatEsArDateTime(new Date());

      if (shouldSendTemp || shouldSendCurr) {
        const lines: string[] = [];
        if (shouldSendTemp) lines.push(...tempMsgs);
        if (shouldSendCurr) lines.push(currentMsg);
        const bodyText = `${lines.join('\n\n')}\n\nDetectado: ${when}`;
        let title: string;
        if (shouldSendTemp && shouldSendCurr) title = `${deviceName} · alertas`;
        else if (shouldSendTemp) title = `${deviceName} · temperatura`;
        else title = `${deviceName} · corriente`;

        const pushResult = await sendPushToOwnerAndAdmins(supabase, device.owner_user_id, {
          title,
          body: bodyText,
          data: {
            type: shouldSendCurr && !shouldSendTemp ? 'current_breach' : 'temp_breach',
            deviceId: device.id,
          },
          tag: `alarm-${device.id}`,
          navigate: `/alertas?deviceId=${encodeURIComponent(device.id)}`,
          requireInteraction: true,
        });

        const nowIso = new Date().toISOString();
        const patch: Record<string, string> = {};
        if (shouldSendTemp) patch.last_push_temp_breach_at = nowIso;
        if (shouldSendCurr) patch.last_push_current_breach_at = nowIso;
        await supabase.from('device_thresholds').update(patch).eq('device_id', device.id);

        /** Historial: solo el 1er aviso del episodio; las repeticiones cada 1 min son solo push. */
        const firstTempPushOfEpisode = shouldSendTemp && !th.last_push_temp_breach_at;
        if (firstTempPushOfEpisode) {
          const combinedMsg = tempMsgs.join('\n');
          const { error: e1 } = await supabase.from('device_alarm_events').insert({
            device_id: device.id,
            owner_user_id: device.owner_user_id,
            triggered_at: nowIso,
            kind: 'temp_breach',
            message: combinedMsg,
            detail: null,
            temp1_c: t1,
            temp2_c: temp2Corrected,
          });
          if (e1) console.warn('[ingest-reading] device_alarm_events temp:', e1.message);
        }
        if (shouldSendCurr) {
          const { error: e2 } = await supabase.from('device_alarm_events').insert({
            device_id: device.id,
            owner_user_id: device.owner_user_id,
            triggered_at: nowIso,
            kind: 'current_breach',
            message: currentMsg,
            detail: null,
            temp1_c: null,
            temp2_c: null,
            current_a: currentA,
          });
          if (e2) console.warn('[ingest-reading] device_alarm_events current:', e2.message);
        }

        pushDiag = {
          sent: pushResult.sent,
          skipped: pushResult.skipped,
          lastError: pushResult.lastError,
        };
        if (pushResult.sent === 0) {
          console.warn('[ingest-reading] alarma sin push entregado:', pushResult);
        }
      }
    }

    const out: Record<string, unknown> = { ok: true };
    if (pushDiag) out.push = pushDiag;
    if (thErr) out.thresholdsWarning = thErr.message;

    return new Response(JSON.stringify(out), {
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
