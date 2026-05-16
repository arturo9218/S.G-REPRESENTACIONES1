/**
 * Parámetros F01–F34 — PR500 para **central frigorífica**: control por presión de proceso (setpoint, diferenciales,
 * etapas de máquinas, alarmas). El punto físico del sensor (succión, descarga, etc.) lo define la instalación.
 * Valores por defecto orientativos; el firmware Stage3 (`esp32_pr500_stage3_app.ino`) y Supabase `fetch-pr500-params` usan el mismo JSON.
 *
 * F01: armado general — 0 = máquinas OFF (relés), 1 = habilitado.
 *
 * F02: setpoint de presión en la unidad de F15 (bar o psi). Rango acotado a la escala del ADC del Stage3 (0…8 bar).
 *
 * F03: diferencial general (misma unidad que F15). Con F22=0: banda simétrica clásica alrededor de F02. Con F22=1:
 * banda “alta presión” (ver F22).
 *
 * F22: histéresis — 0 = etapa ON si P cae por debajo de la banda (típ. succión / más carga térmica). 1 = etapa ON si
 * P ≥ F02+F03−i·F04 y OFF si P ≤ F02−i·F04 (p. ej. regulación por presión alta en el punto medido).
 *
 * F23: falla de sensor (tensión ADC fuera de rango, p. ej. cable cortado): segundos continuos antes de disparar
 * alarma y modo ciclo de compresores; 0 = desactiva esta protección.
 * F24 / F25: en modo falla de sensor, segundos que los compresores (1..F09) quedan encendidos juntos / apagados (ciclo).
 * F26 / F27: tensión mínima y máxima válida en el pin ADC (voltios). Fuera de [F26, F27] se considera falla si F23≠0.
 *
 * F28: 0 = asignación lógica→físico por rotación F08. 1 = balanceo por menor tiempo ON acumulado por compresor (horómetro
 * en el ESP32). La presión sigue definiendo cuántas etapas se piden; F28 solo elige cuáles relés entre equivalentes.
 *
 * F29..F34: sonda de temperatura de succión (DS18B20), refrigerante y chequeo de recalentamiento.
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
  F20: 3,
  F21: 0,
  F22: 0,
  F23: 10,
  F24: 300,
  F25: 300,
  F26: 0.08,
  F27: 3.22,
  F28: 0,
  F29: 0,
  F30: 0,
  F31: 0,
  F32: 0,
  F33: 4,
  F34: 12,
};

/** Modelo editable en formularios (sin `as const` en los defaults, para permitir asignaciones). */
export type Pr500FormModel = typeof PR500_DEFAULTS;

const PR500_ADC_GAP_V = 0.05;

/** Ajusta F26/F27 (V) al rango del ESP32 y deja al menos 50 mV de ventana. */
export function clampPr500F26F27(model: Pr500FormModel): void {
  let lo = Number.isFinite(model.F26) ? model.F26 : PR500_DEFAULTS.F26;
  let hi = Number.isFinite(model.F27) ? model.F27 : PR500_DEFAULTS.F27;
  lo = Math.round(Math.min(3.25, Math.max(0, lo)) * 1000) / 1000;
  hi = Math.round(Math.min(3.3, Math.max(0.05, hi)) * 1000) / 1000;
  if (hi < lo + PR500_ADC_GAP_V) hi = Math.min(3.3, lo + PR500_ADC_GAP_V);
  if (lo > hi - PR500_ADC_GAP_V) lo = Math.max(0, hi - PR500_ADC_GAP_V);
  model.F26 = lo;
  model.F27 = hi;
}

const KEYS = Object.keys(PR500_DEFAULTS) as (keyof Pr500FormModel)[];

/** Igual que el firmware Stage3: F01 solo 0 o 1 (umbrales ≥0.5 → 1). */
export function normalizePr500F01(n: number): 0 | 1 {
  return n >= 0.5 ? 1 : 0;
}

/** 1 bar = 14,5037738 psi (exacto ISO 80000-3). */
export const PR500_PSI_PER_BAR = 14.5037738;

/** Telemetría siempre en bar; convierte a psi para mostrar cuando F15 indica psi. */
export function pr500BarToPsi(bar: number): number {
  if (!Number.isFinite(bar)) return 0;
  return Math.round(bar * PR500_PSI_PER_BAR * 100) / 100;
}

/** Mínimo/máximo F02 en bar (coherente con `pressureBarSensorOnly` 0…8 bar en Stage3). */
export const PR500_F02_BAR_MIN = 0.05;
export const PR500_F02_BAR_MAX = 8;

/** F03 en bar: mínimo el piso del firmware (`updateHyst`); máximo razonable para no saturar la escala 0…8 bar. */
export const PR500_F03_BAR_MIN = 0.05;
export const PR500_F03_BAR_MAX = 6;

/** F15: 0 = bar, 1 = psi (misma regla que el firmware). */
export function normalizePr500F15(n: number): 0 | 1 {
  return n >= 0.5 ? 1 : 0;
}

/** Acota y redondea F02 a 2 decimales según unidad (F15). */
export function clampPr500F02(value: number, f15: number): number {
  const psi = f15 >= 0.5;
  const lo = psi ? PR500_F02_BAR_MIN * PR500_PSI_PER_BAR : PR500_F02_BAR_MIN;
  const hi = psi ? PR500_F02_BAR_MAX * PR500_PSI_PER_BAR : PR500_F02_BAR_MAX;
  let v = Number.isFinite(value) ? value : psi ? 2 * PR500_PSI_PER_BAR : 2;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return Math.round(v * 100) / 100;
}

/** Acota y redondea F03 (diferencial general) a 2 decimales según F15. */
export function clampPr500F03(value: number, f15: number): number {
  const psi = f15 >= 0.5;
  const lo = psi ? PR500_F03_BAR_MIN * PR500_PSI_PER_BAR : PR500_F03_BAR_MIN;
  const hi = psi ? PR500_F03_BAR_MAX * PR500_PSI_PER_BAR : PR500_F03_BAR_MAX;
  let v = Number.isFinite(value) ? value : psi ? 0.5 * PR500_PSI_PER_BAR : 0.5;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return Math.round(v * 100) / 100;
}

/** F04 separación entre etapas: evita valores enormes que dejan C2/C3 siempre ON con F22=1. */
export function clampPr500F04(value: number, f03: number, f15: number): number {
  const psi = f15 >= 0.5;
  let v = Number.isFinite(value) ? value : psi ? 0.4 * PR500_PSI_PER_BAR : 0.4;
  if (v < 0) v = 0;
  let cap = f03 * 0.25;
  const absMax = psi ? 0.5 * PR500_PSI_PER_BAR : 0.5;
  if (cap < 0.05) cap = 0.05;
  if (cap > absMax) cap = absMax;
  if (v > cap) v = cap;
  return Math.round(v * 100) / 100;
}

/**
 * Acota el modelo a los mismos límites que el firmware Stage3 tras cargar/merge (coherencia app ↔ ESP ↔ Supabase).
 */
export function finalizePr500Params(base: Pr500FormModel): void {
  base.F01 = normalizePr500F01(base.F01);
  base.F15 = normalizePr500F15(base.F15);
  base.F16 = normalizePr500F01(base.F16);
  base.F21 = normalizePr500F01(base.F21);
  base.F22 = normalizePr500F01(base.F22);
  base.F28 = normalizePr500F01(base.F28);
  base.F29 = normalizePr500F01(base.F29);
  base.F32 = normalizePr500F01(base.F32);
  base.F30 = Math.max(-40, Math.min(40, Number.isFinite(base.F30) ? base.F30 : 0));
  base.F31 = Math.max(0, Math.min(5, Math.round(Number(base.F31))));
  base.F33 = Math.max(-20, Math.min(40, Number.isFinite(base.F33) ? base.F33 : 4));
  base.F34 = Math.max(-20, Math.min(50, Number.isFinite(base.F34) ? base.F34 : 12));
  if (base.F34 < base.F33 + 0.5) base.F34 = base.F33 + 0.5;
  base.F02 = clampPr500F02(base.F02, base.F15);
  base.F03 = clampPr500F03(base.F03, base.F15);
  base.F04 = clampPr500F04(base.F04, base.F03, base.F15);
  let f23 = Math.round(Number(base.F23));
  if (!Number.isFinite(f23)) f23 = PR500_DEFAULTS.F23;
  if (f23 < 0) f23 = 0;
  else if (f23 > 0 && f23 < 5) f23 = 5;
  else if (f23 > 600) f23 = 600;
  base.F23 = f23;
  const clampSeg = (v: number, lo: number, hi: number, d: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, n));
  };
  base.F24 = clampSeg(base.F24, 10, 7200, PR500_DEFAULTS.F24);
  base.F25 = clampSeg(base.F25, 10, 7200, PR500_DEFAULTS.F25);
  clampPr500F26F27(base);
  let f09 = Math.round(Number(base.F09));
  if (!Number.isFinite(f09)) f09 = PR500_DEFAULTS.F09;
  base.F09 = Math.min(3, Math.max(1, f09));
  let f08 = Math.round(Number(base.F08));
  if (!Number.isFinite(f08)) f08 = PR500_DEFAULTS.F08;
  base.F08 = Math.min(8760, Math.max(0, f08));
  base.F12 = clampSeg(base.F12, 1, 3600, PR500_DEFAULTS.F12);
  base.F13 = clampSeg(base.F13, 1, 3600, PR500_DEFAULTS.F13);
  let f20 = Math.round(Number(base.F20));
  if (!Number.isFinite(f20)) f20 = PR500_DEFAULTS.F20;
  base.F20 = Math.min(999, Math.max(0, f20));
}

export function mergePr500Params(db: unknown): Pr500FormModel {
  const base: Pr500FormModel = { ...PR500_DEFAULTS };
  if (!db || typeof db !== 'object') {
    finalizePr500Params(base);
    return base;
  }
  const o = db as Record<string, unknown>;
  for (const k of KEYS) {
    if (!(k in o)) continue;
    const v = o[k as string];
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    base[k] =
      k === 'F01' || k === 'F16' || k === 'F21' || k === 'F22' || k === 'F28' || k === 'F29' || k === 'F32'
        ? normalizePr500F01(n)
        : k === 'F15'
          ? normalizePr500F15(n)
          : n;
  }
  finalizePr500Params(base);
  return base;
}

export function pr500ToJsonBlob(m: Pr500FormModel): Record<string, number> {
  const snap: Pr500FormModel = { ...m };
  finalizePr500Params(snap);
  const out: Record<string, number> = {};
  const f15 = normalizePr500F15(snap.F15);
  for (const k of KEYS) {
    const v = snap[k];
    if ((k === 'F01' || k === 'F16' || k === 'F21' || k === 'F22' || k === 'F28' || k === 'F29' || k === 'F32') && typeof v === 'number') {
      out[k as string] = normalizePr500F01(v);
    }
    else if (k === 'F15' && typeof v === 'number') out[k as string] = f15;
    else if (k === 'F02' && typeof v === 'number') out[k as string] = clampPr500F02(v, f15);
    else if (k === 'F03' && typeof v === 'number') out[k as string] = clampPr500F03(v, f15);
    else if (k === 'F04' && typeof v === 'number') out[k as string] = clampPr500F04(v, snap.F03, f15);
    else out[k as string] = v as number;
  }
  return out;
}

/** Presión: F02,F03,F04,F10,F11,F14 están en la misma unidad que indica F15 (0=bar, 1=psi). */
const PRESSURE_KEYS_FOR_F15: (keyof Pr500FormModel)[] = ['F02', 'F03', 'F04', 'F10', 'F11', 'F14'];

/**
 * Al cambiar F15, convierte umbrales para conservar la misma presión física.
 * `previousF15` / `nextF15`: 0 = bar, 1 = psi (cualquier ≥0.5 se trata como psi).
 */
export function convertPr500PressureParamsForF15(
  model: Pr500FormModel,
  previousF15: number,
  nextF15: number
): void {
  const fromPsi = previousF15 >= 0.5;
  const toPsi = nextF15 >= 0.5;
  if (fromPsi === toPsi) return;
  const factor = toPsi ? PR500_PSI_PER_BAR : 1 / PR500_PSI_PER_BAR;
  for (const k of PRESSURE_KEYS_FOR_F15) {
    const cur = model[k];
    if (typeof cur === 'number' && Number.isFinite(cur)) {
      model[k] = Math.round(cur * factor * 10000) / 10000;
    }
  }
  model.F02 = clampPr500F02(model.F02, nextF15);
  model.F03 = clampPr500F03(model.F03, nextF15);
  model.F04 = clampPr500F04(model.F04, model.F03, nextF15);
}
