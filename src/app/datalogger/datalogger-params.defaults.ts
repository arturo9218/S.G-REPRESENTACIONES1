/**
 * Parámetros F01–F34 — Datalogger multi-canal.
 * AR01–AR11: canales de fábrica (no se editan en app).
 * AR12–AR20: telemetría y alarmas.
 * AR21–AR23: escala SCT-013 por canal.
 * AR24–AR34: habilitar cada sensor (0 = apagado, 1 = activo).
 * AR35–AR48: corrección (offset) temp / corriente / potencia / presión.
 */
export const SCT_SCALE_AMPS_PER_VOLT = [10, 20, 30, 50, 60] as const;

/** Asignación de canales de fábrica — interno; no se muestra en la app. */
export const DATALOGGER_FIXED_PINS = {
  F01: 34,
  F02: 35,
  F03: 32,
  F04: 33,
  F05: 36,
  F06: 39,
  F07: 25,
  F08: 26,
  F09: 27,
  F10: 14,
  F11: 12,
};

export type DataloggerFormModel = {
  F01: number;
  F02: number;
  F03: number;
  F04: number;
  F05: number;
  F06: number;
  F07: number;
  F08: number;
  F09: number;
  F10: number;
  F11: number;
  F12: number;
  F13: number;
  F14: number;
  F15: number;
  F16: number;
  F17: number;
  F18: number;
  F19: number;
  F20: number;
  F21: number;
  F22: number;
  F23: number;
  F24: number;
  F25: number;
  F26: number;
  F27: number;
  F28: number;
  F29: number;
  F30: number;
  F31: number;
  F32: number;
  F33: number;
  F34: number;
  F35: number;
  F36: number;
  F37: number;
  F38: number;
  F39: number;
  F40: number;
  F41: number;
  F42: number;
  F43: number;
  F44: number;
  F45: number;
  F46: number;
  F47: number;
  F48: number;
};

export const DATALOGGER_DEFAULTS: DataloggerFormModel = {
  ...DATALOGGER_FIXED_PINS,
  /** Intervalo de envío a nube (s) */
  F12: 60,
  /** 0 = solo local, 1 = subir a nube */
  F13: 1,
  /** Tensión nominal línea (V) — solo para W = V × I en consumo */
  F14: 220,
  /** Alarmas temp mín/máx canal 1 (°C); 999 / -999 = desactivado */
  F15: -30,
  F16: 15,
  /** Alarmas temp canal 2 */
  F17: -30,
  F18: 15,
  /** Corriente máxima canal 1 (A); 0 = sin límite */
  F19: 0,
  /** Presión máxima P1 (bar); 0 = sin límite */
  F20: 0,
  /** Escala SCT canal 1: A por 1 V */
  F21: 30,
  F22: 30,
  F23: 30,
  /** Habilitar T1…T6 (0/1) */
  F24: 1,
  F25: 1,
  F26: 0,
  F27: 0,
  F28: 0,
  F29: 0,
  /** Habilitar C1…C3 (0/1) */
  F30: 1,
  F31: 0,
  F32: 0,
  /** Habilitar P1…P2 (0/1) */
  F33: 1,
  F34: 0,
  /** Offset temperatura T1…T6 (°C) */
  F35: 0,
  F36: 0,
  F37: 0,
  F38: 0,
  F39: 0,
  F40: 0,
  /** Offset corriente C1…C3 (A) */
  F41: 0,
  F42: 0,
  F43: 0,
  /** Offset potencia C1…C3 (W) */
  F44: 0,
  F45: 0,
  F46: 0,
  /** Offset presión P1…P2 (bar) */
  F47: 0,
  F48: 0,
};

const ENABLE_KEYS = ['F24', 'F25', 'F26', 'F27', 'F28', 'F29', 'F30', 'F31', 'F32', 'F33', 'F34'] as const;

export type DataloggerEnableKey = (typeof ENABLE_KEYS)[number];

export type DataloggerSensorSlotId =
  | 't1'
  | 't2'
  | 't3'
  | 't4'
  | 't5'
  | 't6'
  | 'c1'
  | 'c2'
  | 'c3'
  | 'p1'
  | 'p2';

export interface DataloggerSensorSlotDef {
  id: DataloggerSensorSlotId;
  enableKey: DataloggerEnableKey;
  label: string;
}

/** AR24–AR34: cada fila = un canal habilitable en la tarjeta / gráfico. */
export const DATALOGGER_SENSOR_SLOTS: readonly DataloggerSensorSlotDef[] = [
  { id: 't1', enableKey: 'F24', label: 'T1' },
  { id: 't2', enableKey: 'F25', label: 'T2' },
  { id: 't3', enableKey: 'F26', label: 'T3' },
  { id: 't4', enableKey: 'F27', label: 'T4' },
  { id: 't5', enableKey: 'F28', label: 'T5' },
  { id: 't6', enableKey: 'F29', label: 'T6' },
  { id: 'c1', enableKey: 'F30', label: 'C1' },
  { id: 'c2', enableKey: 'F31', label: 'C2' },
  { id: 'c3', enableKey: 'F32', label: 'C3' },
  { id: 'p1', enableKey: 'F33', label: 'P1' },
  { id: 'p2', enableKey: 'F34', label: 'P2' },
];

export function dataloggerEnabledSensorSlotIds(params: DataloggerFormModel): DataloggerSensorSlotId[] {
  return DATALOGGER_SENSOR_SLOTS.filter((s) => params[s.enableKey] >= 0.5).map((s) => s.id);
}

export function dataloggerEnabledSensorSlots(params: DataloggerFormModel): DataloggerSensorSlotDef[] {
  return DATALOGGER_SENSOR_SLOTS.filter((s) => params[s.enableKey] >= 0.5);
}

const KEYS = Object.keys(DATALOGGER_DEFAULTS) as (keyof DataloggerFormModel)[];

export function mergeDataloggerParams(raw: unknown): DataloggerFormModel {
  const out = { ...DATALOGGER_DEFAULTS };
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;

  if (o) {
    for (const k of KEYS) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = v;
      } else if (typeof v === 'string') {
        const n = parseFloat(v.replace(',', '.'));
        if (Number.isFinite(n)) out[k] = n;
      }
    }
  }

  Object.assign(out, DATALOGGER_FIXED_PINS);

  /** AR24–AR34: solo flags explícitos (0/1). No inferir desde pines F01–F11 (son GPIO fijos, siempre > 0). */
  for (const enKey of ENABLE_KEYS) {
    out[enKey] = normalizeDataloggerOnOff(out[enKey]);
  }

  out.F13 = normalizeDataloggerF13(out.F13);
  out.F21 = normalizeSctAmpsPerVolt(out.F21);
  out.F22 = normalizeSctAmpsPerVolt(out.F22);
  out.F23 = normalizeSctAmpsPerVolt(out.F23);
  const offsetKeys = [
    'F35', 'F36', 'F37', 'F38', 'F39', 'F40',
    'F41', 'F42', 'F43', 'F44', 'F45', 'F46', 'F47', 'F48',
  ] as const;
  for (const k of offsetKeys) {
    out[k] = normalizeDataloggerOffset(out[k]);
  }
  return out;
}

export function dataloggerToJsonBlob(m: DataloggerFormModel): Record<string, number> {
  const normalized = mergeDataloggerParams(m);
  const o: Record<string, number> = {};
  for (const k of KEYS) {
    o[k] = normalized[k];
  }
  return o;
}

/** @deprecated Los pines son fijos; usar AR24–AR34 para habilitar. */
export function clampDataloggerPin(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(39, Math.round(n));
}

export function normalizeDataloggerF13(n: number): 0 | 1 {
  return n >= 0.5 ? 1 : 0;
}

export function normalizeDataloggerOnOff(n: number): 0 | 1 {
  return n >= 0.5 ? 1 : 0;
}

export function normalizeDataloggerOffset(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** Jumper del módulo SCT-013: 10, 20, 30, 50 o 60 A por cada 1 V de salida. */
export function normalizeSctAmpsPerVolt(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 30;
  let best: number = 30;
  let bestDiff = Infinity;
  for (const v of SCT_SCALE_AMPS_PER_VOLT) {
    const d = Math.abs(n - v);
    if (d < bestDiff) {
      bestDiff = d;
      best = v;
    }
  }
  return best;
}

export function isDataloggerEnableKey(key: keyof DataloggerFormModel): key is DataloggerEnableKey {
  return (ENABLE_KEYS as readonly string[]).includes(key as string);
}
