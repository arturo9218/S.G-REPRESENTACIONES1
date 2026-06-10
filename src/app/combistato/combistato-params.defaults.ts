/**
 * Valores por defecto y fusión con JSON guardado (nube o ESP32 `combistato.json`).
 * Claves F01…F55 y F52t alineadas a `docs/esp32_combistato_supabase.ino`.
 */
export const COMBISTATO_DEFAULTS = {
  F01: -18,
  F02: 3,
  F03: 0,
  F04: 0,
  F05: 0,
  F06: 360,
  F07: 30,
  F08: 8,
  F09: 0,
  F10: 0,
  F11: 2,
  F12: -5,
  F13: 10,
  F14: -30,
  F15: 5,
  F16: 1,
  F17: 60,
  F18: 30,
  F19: 300,
  F20: 300,
  F25: 0,
  F26: 1,
  F27: 120,
  F28: 1,
  F29: 0,
  F30: 0,
  F31: 0,
  F32: 30,
  F33: 0,
  F34: 30,
  F35: 0,
  F36: 30,
  F37: 0,
  F38: 30,
  F39: 3,
  F40: 0,
  F45: 10,
  F46: 1440,
  F47: 1,
  F48: 5,
  F49: 0,
  F50: 0,
  F51: 0,
  F52: 0,
  F52t: -28,
  F53: 0,
  F54: 16,
  F55: 1,
};

export type CombistatoFormModel = { [K in keyof typeof COMBISTATO_DEFAULTS]: number };

const KEYS = Object.keys(COMBISTATO_DEFAULTS) as (keyof CombistatoFormModel)[];

export function mergeCombistatoParams(db: unknown): CombistatoFormModel {
  const base = { ...COMBISTATO_DEFAULTS } as CombistatoFormModel;
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

export function combistatoToJsonBlob(m: CombistatoFormModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KEYS) out[k as string] = m[k];
  return out;
}
