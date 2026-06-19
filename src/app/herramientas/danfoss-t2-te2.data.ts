/**
 * Danfoss T2 / TE2 — cartuchos 0X … 06 (elemento rango N).
 * Curvas TE2 (kW vs Te): R-134a y R-407C a Tc 25 °C, SH apertura 6 K (−40 … +10 °C).
 * R-404A y R-22: Te −30 / −10 / 0 °C (taller / catálogo).
 * R-448A / R-449A: escala vs curva R-404A. Orientativo; confirmar con Coolselector®2.
 */

import {
  pickDanfossValveLine,
  tgeModelHint,
  tr6OrificeHint,
  type DanfossApplication,
  type DanfossValveLineId,
  DANFOSS_VALVE_LINES,
} from './danfoss-valve-lines.data';

export type DanfossOrificeId = '0X' | '00' | '01' | '02' | '03' | '04' | '05' | '06';

export type DanfossRefFamily = 'r404a' | 'r134a' | 'r407c' | 'r22' | 'r448a' | 'r449a';

export type DanfossElementRange = 'N' | 'NL' | 'B';

export interface DanfossOrificeDef {
  id: DanfossOrificeId;
  /** Cartucho de orificio Danfoss (estándar). */
  orificeCode: string;
  label: string;
}

/** Temperaturas de evaporación para interpolación (°F típicas Danfoss → °C). */
export const DANFOSS_EVAP_TEMP_C = [-40, -34.4, -28.9, -23.3, -17.8, -12.2, -6.7, -1.1, 4.4, 10] as const;

/** Curva TE2 completa (R-134a, R-407C): Te −40 … +10 °C, paso 10 K. */
const TE2_FULL_TEMPS_C = [-40, -30, -20, -10, 0, 10] as const;

/** Curva TE2 corta (R-404A, R-22): Te −30 / −10 / 0 °C. */
const TE2_SHORT_TEMPS_C = [-30, -10, 0] as const;

const TR_TO_KW = 3.517;

export const DANFOSS_ORIFICES: readonly DanfossOrificeDef[] = [
  { id: '0X', orificeCode: '068-2002', label: '0X' },
  { id: '00', orificeCode: '068-2003', label: '00' },
  { id: '01', orificeCode: '068-2010', label: '01' },
  { id: '02', orificeCode: '068-2015', label: '02' },
  { id: '03', orificeCode: '068-2006', label: '03' },
  { id: '04', orificeCode: '068-2007', label: '04' },
  { id: '05', orificeCode: '068-2008', label: '05' },
  { id: '06', orificeCode: '068-2009', label: '06' },
];

/** Capacidad nominal a Te = 0 °C (kW). R-134a / R-407C: tabla TE2 Tc 25 °C. */
export const DANFOSS_NOMINAL_KW: Record<DanfossRefFamily, Record<DanfossOrificeId, number>> = {
  r404a: { '0X': 0.38, '00': 0.7, '01': 1.6, '02': 2.1, '03': 4.2, '04': 6.0, '05': 7.7, '06': 9.1 },
  r134a: { '0X': 0.61, '00': 1.03, '01': 1.72, '02': 2.08, '03': 3.49, '04': 5.15, '05': 6.8, '06': 8.16 },
  r407c: { '0X': 0.88, '00': 1.69, '01': 3.19, '02': 4.18, '03': 7.07, '04': 10.6, '05': 14.0, '06': 16.8 },
  r22: { '0X': 0.5, '00': 1.0, '01': 2.5, '02': 3.5, '03': 5.2, '04': 8.0, '05': 10.5, '06': 15.5 },
  r448a: { '0X': 0.38, '00': 0.7, '01': 1.6, '02': 2.1, '03': 4.3, '04': 6.2, '05': 8.0, '06': 9.2 },
  r449a: { '0X': 0.37, '00': 0.68, '01': 1.55, '02': 2.05, '03': 4.1, '04': 5.9, '05': 7.6, '06': 9.0 },
};

/** Curva TE2 (kW) en Te −30 / −10 / 0 °C — R-404A. 0X/00 derivados del nominal × forma de 01. */
const KW_CURVE_R404A: Record<DanfossOrificeId, readonly [number, number, number]> = {
  '0X': [0.14, 0.24, 0.38],
  '00': [0.26, 0.44, 0.7],
  '01': [0.6, 1.0, 1.6],
  '02': [0.9, 1.5, 2.1],
  '03': [1.7, 2.8, 4.2],
  '04': [2.5, 4.0, 6.0],
  '05': [3.5, 5.2, 7.7],
  '06': [4.2, 6.4, 9.1],
};

/** Curva TE2 (kW) en Te −30 / −10 / 0 °C — R-22. */
const KW_CURVE_R22: Record<DanfossOrificeId, readonly [number, number, number]> = {
  '0X': [0.19, 0.38, 0.5],
  '00': [0.38, 0.63, 1.0],
  '01': [0.9, 1.8, 2.5],
  '02': [1.4, 2.5, 3.5],
  '03': [2.0, 3.8, 5.2],
  '04': [3.2, 5.5, 8.0],
  '05': [4.5, 7.2, 10.5],
  '06': [6.5, 10.2, 15.5],
};

/** TE2 R-134a, Tc 25 °C, SH apertura 6 K — kW en Te −40 … +10 °C. */
const KW_CURVE_R134A: Record<DanfossOrificeId, readonly [number, number, number, number, number, number]> = {
  '0X': [0.48, 0.54, 0.59, 0.62, 0.61, 0.54],
  '00': [0.52, 0.67, 0.82, 0.95, 1.03, 0.98],
  '01': [0.7, 0.92, 1.19, 1.48, 1.72, 1.77],
  '02': [0.78, 1.03, 1.35, 1.73, 2.08, 2.24],
  '03': [1.31, 1.72, 2.27, 2.89, 3.49, 3.76],
  '04': [1.89, 2.49, 3.28, 4.21, 5.15, 5.69],
  '05': [2.5, 3.28, 4.33, 5.57, 6.8, 7.48],
  '06': [2.98, 3.93, 5.2, 6.69, 8.16, 8.96],
};

/** TE2 R-407C, Tc 25 °C, SH apertura 6 K — kW en Te −40 … +10 °C. */
const KW_CURVE_R407C: Record<DanfossOrificeId, readonly [number, number, number, number, number, number]> = {
  '0X': [0.76, 0.83, 0.88, 0.9, 0.88, 0.81],
  '00': [0.99, 1.21, 1.42, 1.6, 1.69, 1.63],
  '01': [1.41, 1.8, 2.27, 2.77, 3.19, 3.31],
  '02': [1.59, 2.06, 2.67, 3.4, 4.18, 4.64],
  '03': [2.65, 3.44, 4.46, 5.73, 7.07, 7.85],
  '04': [3.86, 4.98, 6.44, 8.35, 10.6, 12.5],
  '05': [5.04, 6.52, 8.46, 11.0, 14.0, 16.3],
  '06': [5.94, 7.71, 10.1, 13.2, 16.8, 19.4],
};

function interpolateKwAtTe(xs: readonly number[], values: readonly number[], teC: number): number {
  if (!xs.length || xs.length !== values.length) return 0;
  if (teC <= xs[0]) {
    if (xs.length === 1) return values[0];
    const slope = (values[1] - values[0]) / (xs[1] - xs[0]);
    return Math.max(0, values[0] + slope * (teC - xs[0]));
  }
  if (teC >= xs[xs.length - 1]) {
    const i = xs.length - 1;
    const slope = (values[i] - values[i - 1]) / (xs[i] - xs[i - 1]);
    return Math.max(0, values[i] + slope * (teC - xs[i]));
  }
  for (let i = 0; i < xs.length - 1; i++) {
    if (teC <= xs[i + 1]) {
      const t = (teC - xs[i]) / (xs[i + 1] - xs[i]);
      return lerp(values[i], values[i + 1], t);
    }
  }
  return values[values.length - 1];
}

function orificeCapacityKwAtTe(family: DanfossRefFamily, orifice: DanfossOrificeId, teC: number): number {
  if (family === 'r134a') {
    return interpolateKwAtTe(TE2_FULL_TEMPS_C, KW_CURVE_R134A[orifice], teC);
  }
  if (family === 'r407c') {
    return interpolateKwAtTe(TE2_FULL_TEMPS_C, KW_CURVE_R407C[orifice], teC);
  }
  if (family === 'r404a') {
    return interpolateKwAtTe(TE2_SHORT_TEMPS_C, KW_CURVE_R404A[orifice], teC);
  }
  if (family === 'r22') {
    return interpolateKwAtTe(TE2_SHORT_TEMPS_C, KW_CURVE_R22[orifice], teC);
  }
  const r404 = interpolateKwAtTe(TE2_SHORT_TEMPS_C, KW_CURVE_R404A[orifice], teC);
  const scale = DANFOSS_NOMINAL_KW[family][orifice] / DANFOSS_NOMINAL_KW.r404a[orifice];
  return r404 * scale;
}

const REFRIGERANT_FAMILY: Record<string, DanfossRefFamily> = {
  r404a: 'r404a',
  r507: 'r404a',
  r134a: 'r134a',
  r513a: 'r134a',
  r407c: 'r407c',
  r407a: 'r407c',
  r407f: 'r407c',
  r22: 'r22',
  r448a: 'r448a',
  r449a: 'r449a',
  r452a: 'r404a',
  r455a: 'r404a',
  r454c: 'r404a',
};

export function danfossFamilyForRefrigerant(refrigerantId: string): DanfossRefFamily | null {
  return REFRIGERANT_FAMILY[refrigerantId] ?? null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Capacidad del cartucho (kW) para un refrigerante de la app. */
export function danfossOrificeCapacityKw(
  refrigerantId: string,
  orifice: DanfossOrificeId,
  teC: number
): number | null {
  const family = danfossFamilyForRefrigerant(refrigerantId);
  if (family) return orificeCapacityKwAtTe(family, orifice, teC);

  const r404 = orificeCapacityKwAtTe('r404a', orifice, teC);
  const r404Nom = DANFOSS_NOMINAL_KW.r404a[orifice];
  const refNom = estimateNominalKw(refrigerantId, orifice);
  if (refNom == null || r404Nom <= 0) return null;
  return r404 * (refNom / r404Nom);
}

function estimateNominalKw(refrigerantId: string, orifice: DanfossOrificeId): number | null {
  const family = danfossFamilyForRefrigerant(refrigerantId);
  if (family) return DANFOSS_NOMINAL_KW[family][orifice];

  /** Aproximación para refrigerantes sin tabla propia: escala vs R404A según presión relativa a -10 °C. */
  const scaleByRef: Record<string, number> = {
    r410a: 1.05,
    r32: 1.08,
    r454a: 1.05,
    r454b: 1.04,
    r454c: 0.95,
    r290: 0.55,
    r600a: 0.35,
    r1270: 0.52,
    r717: 0.75,
    r744: 2.4,
    r23: 0.45,
    r508b: 0.42,
    r1234yf: 0.55,
  };
  const scale = scaleByRef[refrigerantId];
  if (scale == null) return null;
  return DANFOSS_NOMINAL_KW.r404a[orifice] * scale;
}

/** Factor fsub (tabla Danfoss, subenfriamiento líquido). */
export function danfossSubcoolingFactor(subcoolingK: number): number {
  const sc = Number.isFinite(subcoolingK) ? Math.max(0, subcoolingK) : 3;
  if (sc <= 2) return 0.98;
  if (sc <= 4) return lerp(0.98, 1, (sc - 2) / 2);
  if (sc <= 10) return lerp(1, 1.07, (sc - 4) / 6);
  if (sc <= 15) return lerp(1.07, 1.12, (sc - 10) / 5);
  return 1.12;
}

/** Factor fp (caída en distribuidor; 0 bar = 1). */
export function danfossDistributorFactor(pressureDropBar: number): number {
  const dp = Number.isFinite(pressureDropBar) ? Math.max(0, pressureDropBar) : 0;
  if (dp <= 0) return 1;
  if (dp <= 1) return 0.96;
  if (dp <= 1.5) return 0.94;
  if (dp <= 2) return 0.92;
  return 0.9;
}

/** Tablas TE2 / T2 Danfoss: Tc = 25 °C, SH apertura 6 K. */
export const DANFOSS_T2_TE2_TC_NOMINAL_C = 25;

/** Mínimo cap / carga corregida para aceptar un cartucho (≥ 100 %). */
export const ORIFICE_MIN_CAPACITY_RATIO = 1;

/**
 * A mayor Tc, el cartucho rinde menos kW → sube la carga corregida a cubrir.
 * Referencia: tablas TE2 a Tc 25 °C (no 38 °C).
 */
export function danfossCondensingFactor(condTempC: number): number {
  const tc = Number.isFinite(condTempC) ? condTempC : DANFOSS_T2_TE2_TC_NOMINAL_C;
  return 1 + (tc - DANFOSS_T2_TE2_TC_NOMINAL_C) * 0.012;
}

export function danfossElementRange(teC: number): { id: DanfossElementRange; label: string; mopNote: string } {
  if (teC < -25) {
    return {
      id: 'B',
      label: 'Rango B (−60 a −25 °C)',
      mopNote: 'Ultracongelación; elemento con carga específica.',
    };
  }
  if (teC < -15) {
    return {
      id: 'NL',
      label: 'Rango NL (−40 a −15 °C, MOP −10 °C)',
      mopNote: 'Congelación media; protege compresor en descongelamiento.',
    };
  }
  return {
    id: 'N',
    label: 'Rango N (−40 a +10 °C)',
    mopNote: 'Refrigeración comercial habitual.',
  };
}

export function danfossOrificeByCode(id: DanfossOrificeId): DanfossOrificeDef {
  return DANFOSS_ORIFICES.find((o) => o.id === id)!;
}

export interface DanfossValveSelection {
  valveLine: DanfossValveLineId;
  valveLineLabel: string;
  lineReason: string;
  alternatives: string[];
  valveBody: string;
  orifice: string;
  orificeCode: string;
  elementRange: ReturnType<typeof danfossElementRange>;
  ratedCapacityKw: number;
  requiredCapacityKw: number;
  nextOrifice?: string;
  nextRatedCapacityKw?: number;
  family: DanfossRefFamily | 'estimado';
  estimatedRefrigerant: boolean;
  /** true = cartucho 06 de T2/TE2 no alcanza la carga. */
  t2OrificeOverflow: boolean;
}

export { DANFOSS_VALVE_LINES, type DanfossApplication, type DanfossValveLineId };

/** Selección completa: línea Danfoss + cuerpo + orificio según condiciones. */
export function selectDanfossValve(input: {
  refrigerantId: string;
  capacityKw: number;
  evapTempC: number;
  condTempC: number;
  subcoolingK: number;
  distributorDropBar: number;
  externalEqualization: boolean;
  application: DanfossApplication;
}): DanfossValveSelection | null {
  const q = input.capacityKw;
  if (!Number.isFinite(q) || q <= 0) return null;

  const fsub = danfossSubcoolingFactor(input.subcoolingK);
  const fp = danfossDistributorFactor(input.distributorDropBar);
  const ftc = danfossCondensingFactor(input.condTempC);
  const requiredKw = (q / (fsub * fp)) * ftc;

  const t2 = selectT2Te2Orifice(input, requiredKw);
  if (!t2) return null;

  const t2Overflow = t2.orifice === '06' && requiredKw > t2.rated * ORIFICE_MIN_CAPACITY_RATIO;
  const linePick = pickDanfossValveLine({
    requiredKw,
    evapTempC: input.evapTempC,
    refrigerantId: input.refrigerantId,
    application: input.application,
    externalEqualization: input.externalEqualization,
    t2MaxOrificeInsufficient: t2Overflow,
  });

  const elementRange = danfossElementRange(input.evapTempC);
  const bodyT2 = input.externalEqualization ? 'TE2' : 'T2';

  if (linePick.line === 'tr6') {
    const tr6 = tr6OrificeHint(requiredKw);
    return {
      valveLine: 'tr6',
      valveLineLabel: linePick.label,
      lineReason: linePick.reason,
      alternatives: linePick.alternatives,
      valveBody: 'TR6',
      orifice: tr6.orifice,
      orificeCode: `067L5${tr6.orifice} (kit 067L7000 R410A)`,
      elementRange,
      ratedCapacityKw: tr6.trNominal * TR_TO_KW,
      requiredCapacityKw: requiredKw,
      family: danfossFamilyForRefrigerant(input.refrigerantId) ?? 'estimado',
      estimatedRefrigerant: danfossFamilyForRefrigerant(input.refrigerantId) == null,
      t2OrificeOverflow: t2Overflow,
      nextOrifice: undefined,
    };
  }

  if (linePick.line === 'tge') {
    const tge = tgeModelHint(requiredKw);
    return {
      valveLine: 'tge',
      valveLineLabel: linePick.label,
      lineReason: linePick.reason,
      alternatives: linePick.alternatives,
      valveBody: tge.model.split(' ').slice(0, 2).join(' '),
      orifice: tge.model,
      orificeCode: 'Consultar código 067N… en catálogo',
      elementRange,
      ratedCapacityKw: tge.trNominal * TR_TO_KW,
      requiredCapacityKw: requiredKw,
      family: danfossFamilyForRefrigerant(input.refrigerantId) ?? 'estimado',
      estimatedRefrigerant: danfossFamilyForRefrigerant(input.refrigerantId) == null,
      t2OrificeOverflow: true,
    };
  }

  return {
    valveLine: 't2_te2',
    valveLineLabel: linePick.label,
    lineReason: linePick.reason,
    alternatives: linePick.alternatives,
    valveBody: bodyT2,
    orifice: t2.orifice,
    orificeCode: t2.orificeCode,
    elementRange,
    ratedCapacityKw: t2.rated,
    requiredCapacityKw: requiredKw,
    nextOrifice: t2.nextOrifice,
    nextRatedCapacityKw: t2.nextRated,
    family: t2.family,
    estimatedRefrigerant: t2.estimated,
    t2OrificeOverflow: t2Overflow,
  };
}

function selectT2Te2Orifice(
  input: {
    refrigerantId: string;
    evapTempC: number;
    externalEqualization: boolean;
  },
  requiredKw: number
): {
  orifice: DanfossOrificeId;
  orificeCode: string;
  rated: number;
  nextOrifice?: DanfossOrificeId;
  nextRated?: number;
  family: DanfossRefFamily | 'estimado';
  estimated: boolean;
} | null {
  const family = danfossFamilyForRefrigerant(input.refrigerantId);
  const estimated = family == null;

  let selected: DanfossOrificeId | null = null;
  let rated = 0;
  let next: DanfossOrificeId | undefined;
  let nextRated: number | undefined;

  for (const orifice of DANFOSS_ORIFICES) {
    const cap = danfossOrificeCapacityKw(input.refrigerantId, orifice.id, input.evapTempC);
    if (cap == null) return null;
    if (cap >= requiredKw * ORIFICE_MIN_CAPACITY_RATIO) {
      selected = orifice.id;
      rated = cap;
      const idx = DANFOSS_ORIFICES.findIndex((o) => o.id === orifice.id);
      if (idx >= 0 && idx < DANFOSS_ORIFICES.length - 1) {
        next = DANFOSS_ORIFICES[idx + 1].id;
        nextRated = danfossOrificeCapacityKw(input.refrigerantId, next, input.evapTempC) ?? undefined;
      }
      break;
    }
  }

  if (!selected) {
    selected = '06';
    rated = danfossOrificeCapacityKw(input.refrigerantId, '06', input.evapTempC) ?? 0;
  }

  const def = danfossOrificeByCode(selected);
  return {
    orifice: selected,
    orificeCode: def.orificeCode,
    rated,
    nextOrifice: next,
    nextRated,
    family: family ?? 'estimado',
    estimated,
  };
}

/** @deprecated Usar selectDanfossValve */
export function selectDanfossT2Te2(input: {
  refrigerantId: string;
  capacityKw: number;
  evapTempC: number;
  condTempC: number;
  subcoolingK: number;
  distributorDropBar: number;
  externalEqualization: boolean;
}): DanfossValveSelection | null {
  return selectDanfossValve({ ...input, application: 'refrigeracion' });
}
