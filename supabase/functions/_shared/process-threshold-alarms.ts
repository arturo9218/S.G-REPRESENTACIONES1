import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPushToCombistatoRecipients, sendPushToOwnerAndAdmins } from './send-web-push.ts';
import { formatEsArDateTime } from './format-datetime.ts';

const TEMP_PUSH_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_TEMP_PUSH_COOLDOWN_MS = 60 * 1000;
const REPEAT_TEMP_BREACH_MS = 60 * 1000;

export interface ThresholdRow {
  notifications_enabled?: boolean;
  temp1_min_c?: number | null;
  temp1_max_c?: number | null;
  temp2_min_c?: number | null;
  temp2_max_c?: number | null;
  temp_push_cooldown_ms?: number | null;
  last_push_temp_breach_at?: string | null;
  temp_breach_episode_started_at?: string | null;
  current_max_a?: number | null;
  last_push_current_breach_at?: string | null;
}

export interface ThresholdAlarmContext {
  supabase: SupabaseClient;
  thresholdsTable: 'device_thresholds' | 'combistatos';
  thresholdsIdColumn: 'device_id' | 'combistato_id' | 'id';
  entityId: string;
  ownerUserId: string;
  entityName: string;
  sensor1Label: string;
  sensor2Label: string;
  t1: number;
  t2: number | null;
  /** Solo paneles con pinza; null en PRO300. */
  currentA?: number | null;
  th: ThresholdRow | null | undefined;
  alarmEventsTable: 'device_alarm_events' | 'combistato_alarm_events';
  alarmEventsIdColumn: 'device_id' | 'combistato_id';
  pushTag: string;
  pushNavigate: string;
  pushDataIdKey: 'deviceId' | 'combistatoId';
  /** PRO300: igual que firmware (>= AR24, <= AR25). */
  compareHigh?: 'gt' | 'gte';
  compareLow?: 'lt' | 'lte';
  /** Si se define, reemplaza la lógica de “volvió a rango” (p. ej. histéresis AR28). */
  isTempInRange?: (t1: number, t2: number | null) => boolean;
}

export type ThresholdAlarmPushDiag = {
  sent: number;
  skipped?: string;
  lastError?: string;
};

/**
 * Evalúa umbrales de temperatura (y corriente si aplica), envía Web Push y registra historial.
 */
export async function processThresholdAlarms(
  ctx: ThresholdAlarmContext
): Promise<ThresholdAlarmPushDiag | undefined> {
  const th = ctx.th;
  if (!th?.notifications_enabled || !ctx.ownerUserId) return undefined;

  const tempMsgs: string[] = [];
  const hiCmp = ctx.compareHigh ?? 'gt';
  const loCmp = ctx.compareLow ?? 'lt';
  if (th.temp1_min_c != null) {
    const lowBreach = loCmp === 'lte' ? ctx.t1 <= th.temp1_min_c : ctx.t1 < th.temp1_min_c;
    if (lowBreach) {
      tempMsgs.push(
        `${ctx.sensor1Label}: ${ctx.t1.toFixed(1)} °C, por debajo del mínimo configurado (${th.temp1_min_c} °C).`
      );
    }
  }
  if (th.temp1_max_c != null) {
    const highBreach = hiCmp === 'gte' ? ctx.t1 >= th.temp1_max_c : ctx.t1 > th.temp1_max_c;
    if (highBreach) {
      tempMsgs.push(
        `${ctx.sensor1Label}: ${ctx.t1.toFixed(1)} °C, por encima del máximo configurado (${th.temp1_max_c} °C).`
      );
    }
  }
  if (ctx.t2 != null) {
    if (th.temp2_min_c != null && ctx.t2 < th.temp2_min_c) {
      tempMsgs.push(
        `${ctx.sensor2Label}: ${ctx.t2.toFixed(1)} °C, por debajo del mínimo configurado (${th.temp2_min_c} °C).`
      );
    }
    if (th.temp2_max_c != null && ctx.t2 > th.temp2_max_c) {
      tempMsgs.push(
        `${ctx.sensor2Label}: ${ctx.t2.toFixed(1)} °C, por encima del máximo configurado (${th.temp2_max_c} °C).`
      );
    }
  }

  let currentMsg = '';
  let currentBreach = false;
  const currentA = ctx.currentA ?? null;
  const maxA = th.current_max_a;
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
  const inRange =
    ctx.isTempInRange != null
      ? ctx.isTempInRange(ctx.t1, ctx.t2)
      : !tempBreach;
  const configuredCooldown =
    typeof th.temp_push_cooldown_ms === 'number' && Number.isFinite(th.temp_push_cooldown_ms)
      ? Math.max(MIN_TEMP_PUSH_COOLDOWN_MS, Math.round(th.temp_push_cooldown_ms))
      : TEMP_PUSH_COOLDOWN_MS;
  const now = Date.now();

  if (inRange) {
    const tr = th as Record<string, unknown>;
    const ep = tr['temp_breach_episode_started_at'];
    if (typeof ep === 'string' || th.last_push_temp_breach_at) {
      await ctx.supabase
        .from(ctx.thresholdsTable)
        .update({
          temp_breach_episode_started_at: null,
          last_push_temp_breach_at: null,
        })
        .eq(ctx.thresholdsIdColumn, ctx.entityId);
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
      await ctx.supabase
        .from(ctx.thresholdsTable)
        .update({ temp_breach_episode_started_at: t0 })
        .eq(ctx.thresholdsIdColumn, ctx.entityId);
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

  if (!shouldSendTemp && !shouldSendCurr) return undefined;

  const lines: string[] = [];
  if (shouldSendTemp) lines.push(...tempMsgs);
  if (shouldSendCurr) lines.push(currentMsg);
  const when = formatEsArDateTime(new Date());
  const bodyText = `${lines.join('\n\n')}\n\nDetectado: ${when}`;
  let title: string;
  if (shouldSendTemp && shouldSendCurr) title = `${ctx.entityName} · alertas`;
  else if (shouldSendTemp) title = `${ctx.entityName} · temperatura`;
  else title = `${ctx.entityName} · corriente`;

  const pushPayload = {
    title,
    body: bodyText,
    data: {
      type: shouldSendCurr && !shouldSendTemp ? 'current_breach' : 'temp_breach',
      [ctx.pushDataIdKey]: ctx.entityId,
    },
    tag: ctx.pushTag,
    navigate: ctx.pushNavigate,
    requireInteraction: true,
  };
  const pushResult =
    ctx.thresholdsTable === 'combistatos'
      ? await sendPushToCombistatoRecipients(
          ctx.supabase,
          ctx.entityId,
          ctx.ownerUserId,
          pushPayload
        )
      : await sendPushToOwnerAndAdmins(ctx.supabase, ctx.ownerUserId, pushPayload);

  const nowIso = new Date().toISOString();
  if (pushResult.sent > 0) {
    const patch: Record<string, string> = {};
    if (shouldSendTemp) patch.last_push_temp_breach_at = nowIso;
    if (shouldSendCurr) patch.last_push_current_breach_at = nowIso;
    await ctx.supabase
      .from(ctx.thresholdsTable)
      .update(patch)
      .eq(ctx.thresholdsIdColumn, ctx.entityId);
  }

  const firstTempPushOfEpisode = shouldSendTemp && !th.last_push_temp_breach_at;
  if (firstTempPushOfEpisode) {
    const combinedMsg = tempMsgs.join('\n');
    const ins: Record<string, unknown> = {
      [ctx.alarmEventsIdColumn]: ctx.entityId,
      owner_user_id: ctx.ownerUserId,
      triggered_at: nowIso,
      kind: 'temp_breach',
      message: combinedMsg,
      detail: null,
      temp1_c: ctx.t1,
      temp2_c: ctx.t2,
    };
    const { error: e1 } = await ctx.supabase.from(ctx.alarmEventsTable).insert(ins);
    if (e1) console.warn('[process-threshold-alarms] alarm_events temp:', e1.message);
  }
  if (shouldSendCurr && ctx.alarmEventsTable === 'device_alarm_events') {
    const { error: e2 } = await ctx.supabase.from('device_alarm_events').insert({
      device_id: ctx.entityId,
      owner_user_id: ctx.ownerUserId,
      triggered_at: nowIso,
      kind: 'current_breach',
      message: currentMsg,
      detail: null,
      temp1_c: null,
      temp2_c: null,
      current_a: currentA ?? null,
    });
    if (e2) console.warn('[process-threshold-alarms] device_alarm_events current:', e2.message);
  }

  if (pushResult.sent === 0) {
    console.warn('[process-threshold-alarms] alarma sin push entregado:', pushResult);
  }

  return {
    sent: pushResult.sent,
    skipped: pushResult.skipped,
    lastError: pushResult.lastError,
  };
}
