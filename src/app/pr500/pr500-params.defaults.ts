/**
 * Parámetros F01–F21 alineados al control por presión PR500 (setpoint, diferenciales, etapas, alarmas).
 * Valores por defecto orientativos; el firmware ESP32 puede sincronizar el mismo JSON.
 */
export const PR500_DEFAULTS = {
  F01: 0,
  F02: 2.0,
  F03: 0.5,
  F04: 0.4,
  F05: 30,
  F06: 120,
  F07: 180,
  F08: 24,
  F09: 3,
  F10: 0.5,
  F11: 15,
  F12: 60,
  F13: 60,
  F14: 0,
  F15: 0,
  F16: 0,
  F17: 0,
  F18: 0,
  F19: 0,
  F20: 1,
  F21: 0,
};

/** Modelo editable en formularios (sin `as const` en los defaults, para permitir asignaciones). */
export type Pr500FormModel = typeof PR500_DEFAULTS;

const KEYS = Object.keys(PR500_DEFAULTS) as (keyof Pr500FormModel)[];

export function mergePr500Params(db: unknown): Pr500FormModel {
  const base: Pr500FormModel = { ...PR500_DEFAULTS };
  if (!db || typeof db !== 'object') return base;
  const o = db as Record<string, unknown>;
  for (const k of KEYS) {
    if (!(k in o)) continue;
    const v = o[k as string];
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) base[k] = n;
  }
  return base;
}

export function pr500ToJsonBlob(m: Pr500FormModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KEYS) out[k as string] = m[k];
  return out;
}
