// Supabase Edge Function: ingest-reading
// Recibe telemetría del dispositivo y guarda en device_readings.
// Deploy:
// supabase functions deploy ingest-reading --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { processThresholdAlarms } from '../_shared/process-threshold-alarms.ts';
import {
  combistatoDefrostSuppressesTempAlarms,
  combistatoParamsToThresholdRow,
  parseCombistatoAlarmParams,
} from '../_shared/combistato-param-alarms.ts';

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
  /** Datalogger: 6T + 3 consumos + 2 presiones */
  temp4_c?: number | null;
  temp5_c?: number | null;
  temp6_c?: number | null;
  current1_a?: number | null;
  current2_a?: number | null;
  current3_a?: number | null;
  power1_w?: number | null;
  power2_w?: number | null;
  power3_w?: number | null;
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
  /** Firmware: marca de params que tiene el equipo (pull inmediato si difiere). */
  params_updated_at?: string;
}

const DATALOGGER_CHANNEL_KEYS = [
  'temp1_c',
  'temp2_c',
  'temp3_c',
  'temp4_c',
  'temp5_c',
  'temp6_c',
  'current1_a',
  'current2_a',
  'current3_a',
  'power1_w',
  'power2_w',
  'power3_w',
  'press1_bar',
  'press2_bar',
] as const;

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
function clampInt(raw: unknown, max = 86400): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
}

function ingestOptionalBool(v: unknown): boolean | null {
  if (v === undefined || v === null) return null;
  return ingestBool(v);
}

function ingestOptionalNumber(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasDataloggerChannel(payload: IngestPayload): boolean {
  for (const k of DATALOGGER_CHANNEL_KEYS) {
    if (ingestOptionalNumber(payload[k]) != null) return true;
  }
  return false;
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
    const hasDlgChannel = hasDataloggerChannel(payload);
    if (!moduleId || !deviceToken || (!hasTemp && !hasPressure && !hasDlgChannel)) {
      return new Response(
        JSON.stringify({
          error:
            'Payload inválido: hace falta temp1_c (panel/combistato), pressure_bar (PR500) o al menos un canal datalogger.',
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
      .select(
        'id, device_token_hash, active, owner_user_id, name, sensor_1_label, sensor_2_label, updated_at, params, equipment_kind'
      )
      .eq('module_id', moduleId)
      .single();

    if (devErr || !device) {
      const { data: combi, error: combiErr } = await supabase
        .from('combistatos')
        .select(
          'id, device_token_hash, updated_at, pending_command, owner_user_id, name, params, last_push_temp_breach_at, temp_breach_episode_started_at'
        )
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

        let combiPushDiag: { sent: number; skipped?: string; lastError?: string } | undefined;
        const combiName = typeof combi.name === 'string' ? combi.name : 'PRO300';
        const combiOwner =
          typeof combi.owner_user_id === 'string' ? combi.owner_user_id : '';
        const alarmP = parseCombistatoAlarmParams(combi.params);
        const t1 = payload.temp1_c as number;
        const thRow = combistatoParamsToThresholdRow(combi.params, {
          last_push_temp_breach_at: combi.last_push_temp_breach_at as string | null,
          temp_breach_episode_started_at: combi.temp_breach_episode_started_at as string | null,
        });
        const hys = alarmP.hysteresisC;
        const defrostOn = ingestBool(payload.defrost_on);
        const suppressTempAlarms = combistatoDefrostSuppressesTempAlarms(phase, defrostOn);
        if (suppressTempAlarms) {
          if (combi.temp_breach_episode_started_at || combi.last_push_temp_breach_at) {
            await supabase
              .from('combistatos')
              .update({
                temp_breach_episode_started_at: null,
                last_push_temp_breach_at: null,
              })
              .eq('id', combi.id);
          }
        } else {
          combiPushDiag = await processThresholdAlarms({
            supabase,
            thresholdsTable: 'combistatos',
            thresholdsIdColumn: 'id',
            entityId: combi.id,
            ownerUserId: combiOwner,
            entityName: combiName,
            sensor1Label: 'Sonda 1 (AR24/AR25)',
            sensor2Label: 'Sonda 2',
            t1,
            t2: t2 == null ? null : (t2 as number),
            th: thRow,
            alarmEventsTable: 'combistato_alarm_events',
            alarmEventsIdColumn: 'combistato_id',
            pushTag: `alarm-combistato-${combi.id}`,
            pushNavigate: `/alertas?combistatoId=${encodeURIComponent(combi.id)}`,
            pushDataIdKey: 'combistatoId',
            compareHigh: 'gte',
            compareLow: 'lte',
            isTempInRange: (tc) => tc < alarmP.highC - hys && tc > alarmP.lowC + hys,
          });
        }

        // Devolvemos `params_updated_at` (de combistatos) para que el firmware
        // pueda detectar cambios sin esperar el pull periódico de 2 min y
        // disparar un fetch-pro300-params inmediato si difiere del suyo.
        const paramsUpdatedAt =
          typeof combi.updated_at === 'string' && combi.updated_at.trim()
            ? combi.updated_at.trim()
            : null;
        let pullParamsNow = false;
        const pendingRaw = combi.pending_command;
        if (
          pendingRaw &&
          typeof pendingRaw === 'object' &&
          !Array.isArray(pendingRaw)
        ) {
          const cmd = pendingRaw as Record<string, unknown>;
          const expiresRaw = typeof cmd['expiresAt'] === 'string' ? cmd['expiresAt'] : '';
          const expires = expiresRaw ? Date.parse(expiresRaw) : NaN;
          pullParamsNow = !Number.isFinite(expires) || expires > Date.now();
        }
        const combiOut: Record<string, unknown> = {
          ok: true,
          kind: 'combistato',
          params_updated_at: paramsUpdatedAt,
          pull_params_now: pullParamsNow,
        };
        if (combiPushDiag) combiOut.push = combiPushDiag;
        return new Response(JSON.stringify(combiOut), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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

      const { data: dlg, error: dlgErr } = await supabase
        .from('datalogger_controllers')
        .select('id, device_token_hash, updated_at, params')
        .eq('module_id', moduleId)
        .maybeSingle();

      if (!dlgErr && dlg?.id && dlg.device_token_hash === deviceToken) {
        const sentIso =
          typeof payload.sentAt === 'string' && payload.sentAt.trim()
            ? payload.sentAt.trim()
            : new Date().toISOString();
        const n = (k: (typeof DATALOGGER_CHANNEL_KEYS)[number]) => ingestOptionalNumber(payload[k]);
        if (!hasDataloggerChannel(payload)) {
          return new Response(JSON.stringify({ error: 'Datalogger: falta al menos un canal numérico' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const offNum = (v: unknown): number =>
          typeof v === 'number' && Number.isFinite(v) ? v : 0;
        const rawParams =
          dlg.params != null && typeof dlg.params === 'object' && !Array.isArray(dlg.params)
            ? (dlg.params as Record<string, unknown>)
            : {};
        const off = (key: string) => offNum(rawParams[key]);

        const pair = (raw: number | null, o: number) =>
          raw == null ? { raw: null as number | null, corr: null as number | null } : { raw, corr: raw + o };

        const t1 = pair(n('temp1_c'), off('F35'));
        const t2 = pair(n('temp2_c'), off('F36'));
        const t3 = pair(n('temp3_c'), off('F37'));
        const t4 = pair(n('temp4_c'), off('F38'));
        const t5 = pair(n('temp5_c'), off('F39'));
        const t6 = pair(n('temp6_c'), off('F40'));
        const i1 = pair(n('current1_a'), off('F41'));
        const i2 = pair(n('current2_a'), off('F42'));
        const i3 = pair(n('current3_a'), off('F43'));
        const p1 = pair(n('power1_w'), off('F44'));
        const p2 = pair(n('power2_w'), off('F45'));
        const p3 = pair(n('power3_w'), off('F46'));
        const pr1 = pair(n('press1_bar'), off('F47'));
        const pr2 = pair(n('press2_bar'), off('F48'));

        const insertRow: Record<string, unknown> = {
          datalogger_id: dlg.id,
          created_at: sentIso,
          temp1_raw_c: t1.raw,
          temp2_raw_c: t2.raw,
          temp3_raw_c: t3.raw,
          temp4_raw_c: t4.raw,
          temp5_raw_c: t5.raw,
          temp6_raw_c: t6.raw,
          current1_raw_a: i1.raw,
          current2_raw_a: i2.raw,
          current3_raw_a: i3.raw,
          power1_raw_w: p1.raw,
          power2_raw_w: p2.raw,
          power3_raw_w: p3.raw,
          press1_raw_bar: pr1.raw,
          press2_raw_bar: pr2.raw,
          temp1_c: t1.corr,
          temp2_c: t2.corr,
          temp3_c: t3.corr,
          temp4_c: t4.corr,
          temp5_c: t5.corr,
          temp6_c: t6.corr,
          current1_a: i1.corr,
          current2_a: i2.corr,
          current3_a: i3.corr,
          power1_w: p1.corr,
          power2_w: p2.corr,
          power3_w: p3.corr,
          press1_bar: pr1.corr,
          press2_bar: pr2.corr,
        };
        const { error: insDlgErr } = await supabase.from('datalogger_readings').insert(insertRow);
        if (insDlgErr) {
          return new Response(JSON.stringify({ error: insDlgErr.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const { error: upDlg } = await supabase
          .from('datalogger_controllers')
          .update({ last_seen_at: sentIso })
          .eq('id', dlg.id);
        if (upDlg) {
          return new Response(JSON.stringify({ error: upDlg.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const paramsUpdatedAt =
          typeof dlg.updated_at === 'string' && dlg.updated_at.trim() ? dlg.updated_at.trim() : null;
        const clientUpd =
          typeof payload.params_updated_at === 'string' ? payload.params_updated_at.trim() : '';
        const pullParamsNow = !clientUpd || !paramsUpdatedAt || clientUpd !== paramsUpdatedAt;
        return new Response(
          JSON.stringify({
            ok: true,
            kind: 'datalogger',
            params_updated_at: paramsUpdatedAt,
            pull_params_now: pullParamsNow,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
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
    const phaseRaw = payload.phase;
    const phase = (() => {
      if (typeof phaseRaw !== 'string') return null;
      const v = phaseRaw.trim().toLowerCase();
      const ok = ['boot', 'normal', 'defrost', 'drip', 'post_defrost', 'emerg', 'off'];
      return ok.includes(v) ? v : null;
    })();

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
      phase,
      phase_elapsed_s: clampInt(payload.phase_elapsed_s),
      phase_total_s: clampInt(payload.phase_total_s),
    });

    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    /** Diagnóstico push (útil si no llegan notificaciones); no afecta al dispositivo. */
    let pushDiag: { sent: number; skipped?: string; lastError?: string } | undefined;

    const sensor1Label =
      typeof device.sensor_1_label === 'string' && device.sensor_1_label.trim()
        ? device.sensor_1_label.trim()
        : 'Sensor 1';
    const sensor2Label =
      typeof device.sensor_2_label === 'string' && device.sensor_2_label.trim()
        ? device.sensor_2_label.trim()
        : 'Sensor 2';
    const deviceName = typeof device.name === 'string' ? device.name : 'Dispositivo';
    const ownerId = typeof device.owner_user_id === 'string' ? device.owner_user_id : '';

    pushDiag = await processThresholdAlarms({
      supabase,
      thresholdsTable: 'device_thresholds',
      thresholdsIdColumn: 'device_id',
      entityId: device.id,
      ownerUserId: ownerId,
      entityName: deviceName,
      sensor1Label,
      sensor2Label,
      t1: temp1Corrected,
      t2: temp2Corrected,
      currentA: iCorr,
      th,
      alarmEventsTable: 'device_alarm_events',
      alarmEventsIdColumn: 'device_id',
      pushTag: `alarm-${device.id}`,
      pushNavigate: `/alertas?deviceId=${encodeURIComponent(device.id)}`,
      pushDataIdKey: 'deviceId',
    });

    const out: Record<string, unknown> = { ok: true, kind: 'device' };
    if (pushDiag) out.push = pushDiag;
    if (thErr) out.thresholdsWarning = thErr.message;
    const serverUpd =
      typeof (device as { updated_at?: string }).updated_at === 'string'
        ? (device as { updated_at: string }).updated_at
        : null;
    if (serverUpd) {
      out.params_updated_at = serverUpd;
      const clientUpd =
        typeof payload.params_updated_at === 'string' ? payload.params_updated_at.trim() : '';
      out.pull_params_now = !clientUpd || clientUpd !== serverUpd;
    }

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
