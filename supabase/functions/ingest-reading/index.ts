// Supabase Edge Function: ingest-reading
// Recibe telemetría del dispositivo y guarda en device_readings.
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
  /** Paneles de temperatura y combistato (obligatorio salvo rama PR500 con `pressure_bar`). */
  temp1_c?: number;
  temp2_c?: number | null;
  temp3_c?: number | null;
  /** Corriente RMS (A), ej. SCT-013 */
  current_a?: number | null;
  power_w?: number | null;
  press1_bar?: number | null;
  press2_bar?: number | null;
  /** Combistato: estado de relés / puerta (0/1 o boolean); opcional en firmware viejo. */
  comp_on?: unknown;
  fan_on?: unknown;
  defrost_on?: unknown;
  door_open?: unknown;
  /** PRO300: fase actual del controlador (boot/normal/defrost/drip/post_defrost/emerg/off) + cronómetro. */
  phase?: unknown;
  phase_elapsed_s?: unknown;
  phase_total_s?: unknown;
  /** PRO300: segundos restantes del forzado manual (0 si está en automático). */
  comp_forced_remaining_s?: unknown;
  fan_forced_remaining_s?: unknown;
  /** PR500: presión baja (bar), rama alternativa a temp1_c. */
  pressure_bar?: number | null;
  r1_on?: unknown;
  r2_on?: unknown;
  r3_on?: unknown;
  r4_alarm?: unknown;
  di1_ok?: unknown;
  di2_ok?: unknown;
  di3_ok?: unknown;
  di4_ok?: unknown;
  /** PR500: ms ON acumulados por compresor (horómetro en flash); opcional. */
  comp1_run_ms?: unknown;
  comp2_run_ms?: unknown;
  comp3_run_ms?: unknown;
  temp_suction_c?: unknown;
  superheat_c?: unknown;
  superheat_ok?: unknown;
}

/** Ms totales ON (0…MAX_SAFE_INTEGER); null si ausente o inválido. */
function ingestOptionalRunMs(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > Number.MAX_SAFE_INTEGER) return null;
  return Math.round(n);
}

function ingestBool(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0 && Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'on' || t === 'yes';
  }
  return false;
}

/** Banderas opcionales del firmware PRO300 con control: si el campo no viene, se guarda NULL. */
function ingestOptionalBool(v: unknown): boolean | null {
  if (v === undefined || v === null) return null;
  return ingestBool(v);
}

function ingestOptionalNumber(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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

    const hasTemp =
      typeof payload.temp1_c === 'number' && !Number.isNaN(payload.temp1_c as number);
    const hasPressure =
      typeof payload.pressure_bar === 'number' && !Number.isNaN(payload.pressure_bar as number);
    if (!moduleId || !deviceToken || (!hasTemp && !hasPressure)) {
      return new Response(
        JSON.stringify({
          error: 'Payload inválido: hace falta temp1_c (dispositivo/combistato) o pressure_bar (PR500).',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
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
      const { data: combi, error: combiErr } = await supabase
        .from('combistatos')
        .select('id, device_token_hash, updated_at')
        .eq('module_id', moduleId)
        .maybeSingle();

      if (!combiErr && combi?.id && combi.device_token_hash === deviceToken) {
        if (!hasTemp) {
          return new Response(JSON.stringify({ error: 'Combistato: falta temp1_c numérico' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const sentIso =
          typeof payload.sentAt === 'string' && payload.sentAt.trim()
            ? payload.sentAt.trim()
            : new Date().toISOString();
        const t2 =
          payload.temp2_c == null || Number.isNaN(payload.temp2_c as number)
            ? null
            : (payload.temp2_c as number);
        const clampInt = (raw: unknown, max = 86400): number | null => {
          if (raw === undefined || raw === null) return null;
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(n) || n < 0) return null;
          return Math.min(Math.round(n), max);
        };
        const phaseRaw = payload.phase;
        const phase = (() => {
          if (typeof phaseRaw !== 'string') return null;
          const allowed = ['boot', 'normal', 'defrost', 'drip', 'post_defrost', 'emerg', 'off'];
          const v = phaseRaw.trim().toLowerCase();
          return allowed.includes(v) ? v : null;
        })();
        const { error: insCombErr } = await supabase.from('combistato_readings').insert({
          combistato_id: combi.id,
          created_at: sentIso,
          temp1_c: payload.temp1_c as number,
          temp2_c: t2,
          comp_on: ingestBool(payload.comp_on),
          fan_on: ingestBool(payload.fan_on),
          defrost_on: ingestBool(payload.defrost_on),
          door_open: ingestBool(payload.door_open),
          phase,
          phase_elapsed_s: clampInt(payload.phase_elapsed_s),
          phase_total_s: clampInt(payload.phase_total_s),
          comp_forced_remaining_s: clampInt(payload.comp_forced_remaining_s, 3600),
          fan_forced_remaining_s: clampInt(payload.fan_forced_remaining_s, 3600),
        });
        if (insCombErr) {
          return new Response(JSON.stringify({ error: insCombErr.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const { error: upErr } = await supabase
          .from('combistatos')
          .update({ last_seen_at: sentIso })
          .eq('id', combi.id);
        if (upErr) {
          return new Response(JSON.stringify({ error: upErr.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Devolvemos `params_updated_at` (de combistatos) para que el firmware
        // pueda detectar cambios sin esperar el pull periódico de 2 min y
        // disparar un fetch-pro300-params inmediato si difiere del suyo.
        const paramsUpdatedAt =
          typeof combi.updated_at === 'string' && combi.updated_at.trim()
            ? combi.updated_at.trim()
            : null;
        return new Response(
          JSON.stringify({ ok: true, kind: 'combistato', params_updated_at: paramsUpdatedAt }),
          {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      const { data: pr5, error: pr5Err } = await supabase
        .from('pr500_controllers')
        .select('id, device_token_hash')
        .eq('module_id', moduleId)
        .maybeSingle();

      if (!pr5Err && pr5?.id && pr5.device_token_hash === deviceToken) {
        if (!hasPressure) {
          return new Response(JSON.stringify({ error: 'PR500: falta pressure_bar numérico' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const sentIso =
          typeof payload.sentAt === 'string' && payload.sentAt.trim()
            ? payload.sentAt.trim()
            : new Date().toISOString();
        const diOpt = (v: unknown): boolean | null =>
          v === undefined || v === null ? null : ingestBool(v);
        const r1 = ingestOptionalRunMs(payload.comp1_run_ms);
        const r2 = ingestOptionalRunMs(payload.comp2_run_ms);
        const r3 = ingestOptionalRunMs(payload.comp3_run_ms);
        const insertRow: Record<string, unknown> = {
          pr500_id: pr5.id,
          created_at: sentIso,
          pressure_bar: payload.pressure_bar as number,
          comp1_on: ingestBool(payload.r1_on),
          comp2_on: ingestBool(payload.r2_on),
          comp3_on: ingestBool(payload.r3_on),
          alarm_on: ingestBool(payload.r4_alarm),
          di1_ok: diOpt(payload.di1_ok),
          di2_ok: diOpt(payload.di2_ok),
          di3_ok: diOpt(payload.di3_ok),
          di4_ok: diOpt(payload.di4_ok),
        };
        if (r1 != null) insertRow.comp1_run_ms = r1;
        if (r2 != null) insertRow.comp2_run_ms = r2;
        if (r3 != null) insertRow.comp3_run_ms = r3;
        const ts = ingestOptionalNumber(payload.temp_suction_c);
        const sh = ingestOptionalNumber(payload.superheat_c);
        if (ts != null) insertRow.temp_suction_c = ts;
        if (sh != null) insertRow.superheat_c = sh;
        if (payload.superheat_ok !== undefined && payload.superheat_ok !== null) {
          insertRow.superheat_ok = ingestBool(payload.superheat_ok);
        }
        const { error: insPrErr } = await supabase.from('pr500_readings').insert(insertRow);
        if (insPrErr) {
          return new Response(JSON.stringify({ error: insPrErr.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const { error: upPr } = await supabase
          .from('pr500_controllers')
          .update({ last_seen_at: sentIso })
          .eq('id', pr5.id);
        if (upPr) {
          return new Response(JSON.stringify({ error: upPr.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, kind: 'pr500' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Dispositivo no encontrado' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!hasTemp) {
      return new Response(JSON.stringify({ error: 'Dispositivo: falta temp1_c numérico' }), {
        status: 400,
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
    const oA = num(th?.current_offset_a);
    const oP = num(th?.power_offset_w);

    const temp1Corrected = (payload.temp1_c as number) + o1;
    const temp2Corrected =
      payload.temp2_c == null || Number.isNaN(payload.temp2_c as number)
        ? null
        : (payload.temp2_c as number) + o2;
    const temp3Corrected =
      payload.temp3_c == null || Number.isNaN(payload.temp3_c as number)
        ? null
        : (payload.temp3_c as number) + o3;

    const iRaw =
      payload.current_a != null && Number.isFinite(payload.current_a as number)
        ? (payload.current_a as number)
        : null;
    const iCorr = iRaw != null ? iRaw + oA : null;
    const pRaw =
      payload.power_w != null && Number.isFinite(payload.power_w as number)
        ? (payload.power_w as number)
        : null;
    const pCorr = pRaw != null ? pRaw + oP : null;

    /** Estado de relés (PRO300 con control): opcional, NULL si el firmware no lo manda (PRO400/genéricos). */
    const compOn    = ingestOptionalBool(payload.comp_on);
    const fanOn     = ingestOptionalBool(payload.fan_on);
    const defrostOn = ingestOptionalBool(payload.defrost_on);
    const doorOpen  = ingestOptionalBool(payload.door_open);

    const { error: insErr } = await supabase.from('device_readings').insert({
      device_id: device.id,
      created_at: payload.sentAt ?? new Date().toISOString(),
      temp1_raw_c: payload.temp1_c as number,
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
      current_a_raw: iRaw,
      power_w_raw: pRaw,
      current_a: iCorr,
      power_w: pCorr,
      press1_bar: payload.press1_bar ?? null,
      press2_bar: payload.press2_bar ?? null,
      comp_on: compOn,
      fan_on: fanOn,
      defrost_on: defrostOn,
      door_open: doorOpen,
    });

    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    /** Diagnóstico push (útil si no llegan notificaciones); no afecta al dispositivo. */
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

      /** Umbral de corriente: valor ya corregido por offset (misma lógica que al insertar). */
      const currentA: number | null = iCorr;
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
            current_a: currentA ?? null,
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
