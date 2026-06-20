import type { ThresholdRow } from './process-threshold-alarms.ts';

const MIN_PUSH_COOLDOWN_MS = 60 * 1000;

function paramNum(raw: unknown, key: string, fallback: number): number {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const v = (raw as Record<string, unknown>)[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** AR24–AR29 (F13–F16, F47, F48) desde combistatos.params. */
export interface CombistatoAlarmParams {
  highC: number;
  lowC: number;
  delayMin: number;
  probeAlarmEnabled: boolean;
  hysteresisC: number;
}

export function parseCombistatoAlarmParams(params: unknown): CombistatoAlarmParams {
  return {
    highC: paramNum(params, 'F13', 10),
    lowC: paramNum(params, 'F14', -30),
    delayMin: Math.max(0, paramNum(params, 'F15', 5)),
    probeAlarmEnabled: paramNum(params, 'F16', 1) >= 0.5,
    hysteresisC: Math.max(0, paramNum(params, 'F47', 1)),
  };
}

export interface CombistatoPushState {
  last_push_temp_breach_at?: string | null;
  temp_breach_episode_started_at?: string | null;
}

/** Misma lógica de umbrales que el firmware (tCam / S1, AR24–AR26). */
export function combistatoTempInRange(t1: number, p: CombistatoAlarmParams): boolean {
  const hys = p.hysteresisC;
  return t1 < p.highC - hys && t1 > p.lowC + hys;
}

export function combistatoParamsToThresholdRow(
  params: unknown,
  pushState: CombistatoPushState
): ThresholdRow {
  const p = parseCombistatoAlarmParams(params);
  const delayMs = Math.max(MIN_PUSH_COOLDOWN_MS, Math.round(p.delayMin * 60 * 1000));
  return {
    notifications_enabled: true,
    temp1_max_c: p.highC,
    temp1_min_c: p.lowC,
    temp2_min_c: null,
    temp2_max_c: null,
    temp_push_cooldown_ms: delayMs,
    last_push_temp_breach_at: pushState.last_push_temp_breach_at ?? null,
    temp_breach_episode_started_at: pushState.temp_breach_episode_started_at ?? null,
  };
}

export function combistatoOfflineCooldownMs(params: unknown): number {
  const p = parseCombistatoAlarmParams(params);
  return Math.max(MIN_PUSH_COOLDOWN_MS, Math.round(p.delayMin * 60 * 1000));
}
