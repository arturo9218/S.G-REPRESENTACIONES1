/**
 * Danfoss T2 / TE2 — cartuchos de orificio intercambiables 0X … 06.
 * Capacidades nominales (kW) vs temperatura de evaporación según tablas Danfoss
 * (R-404A / R-507, Tc ≈ 38 °C / 100 °F, recalentamiento de apertura 6 K).
 * Orientativo de taller; confirmar con Coolselector®2 o catálogo Danfoss.
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

/** Temperaturas de evaporación de la tabla Danfoss (°F → °C). */
export const DANFOSS_EVAP_TEMP_C = [-40, -34.4, -28.9, -23.3, -17.8, -12.2, -6.7, -1.1, 4.4, 10] as const;

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

const TR_TO_KW = 3.517;

/** Capacidad en ton (TR) por orificio y columna DANFOSS_EVAP_TEMP_C. */
const TR_TABLE: Record<DanfossRefFamily, Record<DanfossOrificeId, readonly number[]>> = {
  r404a: {
    '0X': [1 / 6, 1 / 8, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 5, 1 / 5, 1 / 5, 1 / 5],
    '00': [1 / 3, 1 / 5, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 3],
    '01': [3 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2, 3 / 4, 3 / 4],
    '02': [1, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1],
    '03': [1.75, 0.5, 0.5, 0.75, 0.75, 1, 1, 4 / 3, 1.5, 1.75],
    '04': [2.75, 0.75, 0.75, 0.75, 1, 1, 4 / 3, 1.5, 2, 2 + 1 / 3],
    '05': [3.75, 1, 1, 1, 1.5, 1.75, 2, 2.5, 3, 3.5],
    '06': [4.5, 1, 1, 4 / 3, 1.75, 2, 2.5, 3, 3.75, 4],
  },
  r134a: {
    '0X': [1 / 5, 1 / 8, 1 / 8, 1 / 6, 1 / 6, 1 / 6, 1 / 5, 1 / 5, 1 / 5, 1 / 5],
    '00': [1 / 3, 1 / 8, 1 / 6, 1 / 5, 1 / 5, 1 / 4, 1 / 4, 1 / 4, 1 / 3, 1 / 3],
    '01': [1 / 2, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2],
    '02': [3 / 4, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2, 3 / 4],
    '03': [1.5, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 4],
    '04': [1.75, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 4, 1 + 1 / 3, 1.5],
    '05': [2 + 1 / 3, 3 / 4, 3 / 4, 1, 1, 1, 1 + 1 / 3, 1.5, 1.75, 2],
    '06': [3.75, 1, 1 + 1 / 4, 1 + 1 / 3, 1.5, 2, 2 + 1 / 4, 2.5, 2.75, 3],
  },
  r407c: {
    '0X': [1 / 4, 1 / 5, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4],
    '00': [1 / 2, 1 / 3, 1 / 3, 2 / 5, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 1 / 2],
    '01': [3 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 3 / 4, 1, 1],
    '02': [1, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1],
    '03': [1.75, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 1.75, 2],
    '04': [2.5, 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 1.75, 2, 2.5, 3],
    '05': [3.5, 1, 1 + 1 / 4, 1.5, 1.75, 2, 2.5, 3, 3.5, 4],
    '06': [4.5, 1 + 1 / 4, 1.5, 1.75, 2, 2.5, 3, 3.75, 4.5, 5],
  },
  r22: {
    '0X': [1 / 4, 1 / 5, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4],
    '00': [1 / 2, 1 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2, 1 / 2],
    '01': [1, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1],
    '02': [1 + 1 / 3, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1],
    '03': [2 + 1 / 3, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 2, 2 + 1 / 3],
    '04': [3.5, 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 2, 2.5, 3, 3.5],
    '05': [4.75, 1, 1 + 1 / 4, 1.5, 1.75, 2, 2.5, 3, 3.5, 4],
    '06': [5.5, 1 + 1 / 2, 2, 2 + 1 / 3, 2.75, 3, 3.75, 4 + 1 / 3, 5, 5.5],
  },
  r448a: {
    '0X': [1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4],
    '00': [1 / 2, 1 / 3, 1 / 3, 2 / 5, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 1 / 2],
    '01': [3 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 3 / 4, 1, 1],
    '02': [1, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1],
    '03': [2 + 1 / 3, 4 / 5, 1, 1, 1 + 2 / 5, 1 + 7 / 8, 2, 2 + 1 / 3, 2.5, 2.75],
    '04': [3.6, 1 + 1 / 5, 1 + 3 / 5, 1 + 3 / 5, 2, 2 + 4 / 5, 3, 3 + 2 / 3, 4, 4.2],
    '05': [4.6, 1 + 3 / 5, 2, 2, 2 + 3 / 4, 3, 3 + 2 / 3, 4 + 3 / 4, 5 + 1 / 5, 5.8],
    '06': [5.6, 1 + 4 / 5, 2.5, 3 + 1 / 3, 4.5, 5 + 3 / 4, 6 + 1 / 4, 6.8, 7.2, 7.5],
  },
  r449a: {
    '0X': [1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4],
    '00': [1 / 2, 1 / 3, 1 / 3, 2 / 5, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 1 / 2],
    '01': [3 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 3 / 4, 1, 1],
    '02': [1, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1],
    '03': [2 + 1 / 5, 4 / 5, 1, 1, 1 + 2 / 5, 1 + 4 / 5, 2, 2 + 2 / 3, 2.5, 2.8],
    '04': [3.4, 1 + 1 / 4, 1 + 3 / 5, 1 + 3 / 5, 2, 2 + 3 / 4, 3, 3.5, 3.8, 4.2],
    '05': [4.5, 1 + 3 / 5, 2, 2, 2 + 3 / 4, 3, 3 + 3 / 5, 4 + 3 / 5, 5, 5.5],
    '06': [5.4, 1 + 7 / 8, 2.5, 3 + 1 / 4, 4 + 1 / 3, 5 + 3 / 5, 6, 6.8, 7.2, 7.8],
  },
};

/** Capacidad nominal a Te = 4,4 °C (tabla técnica Danfoss, kW). */
export const DANFOSS_NOMINAL_KW: Record<DanfossRefFamily, Record<DanfossOrificeId, number>> = {
  r404a: { '0X': 0.9, '00': 1.8, '01': 3.5, '02': 4.7, '03': 8, '04': 12.1, '05': 16.7, '06': 19.7 },
  r134a: { '0X': 0.58, '00': 1, '01': 1.8, '02': 2.2, '03': 3.7, '04': 5.4, '05': 6.9, '06': 8.6 },
  r407c: { '0X': 0.68, '00': 1.2, '01': 2.1, '02': 2.6, '03': 4.3, '04': 6.4, '05': 8.4, '06': 10.1 },
  r22: { '0X': 0.92, '00': 1.8, '01': 3.5, '02': 4.8, '03': 8.1, '04': 12.4, '05': 16.5, '06': 19.7 },
  r448a: { '0X': 0.9, '00': 1.8, '01': 3.5, '02': 4.8, '03': 8.1, '04': 12.6, '05': 16.3, '06': 19.8 },
  r449a: { '0X': 0.88, '00': 1.7, '01': 3.4, '02': 4.6, '03': 7.9, '04': 12.1, '05': 15.7, '06': 19.1 },
};

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

function interpolateAtTemp(values: readonly number[], teC: number): number {
  const xs = DANFOSS_EVAP_TEMP_C;
  if (teC <= xs[0]) return values[0];
  if (teC >= xs[xs.length - 1]) return values[values.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (teC <= xs[i + 1]) {
      const t = (teC - xs[i]) / (xs[i + 1] - xs[i]);
      return lerp(values[i], values[i + 1], t);
    }
  }
  return values[values.length - 1];
}

function trTableKw(family: DanfossRefFamily, orifice: DanfossOrificeId, teC: number): number {
  const tr = interpolateAtTemp(TR_TABLE[family][orifice], teC);
  return tr * TR_TO_KW;
}

/** Capacidad del cartucho (kW) para un refrigerante de la app. */
export function danfossOrificeCapacityKw(
  refrigerantId: string,
  orifice: DanfossOrificeId,
  teC: number
): number | null {
  const family = danfossFamilyForRefrigerant(refrigerantId);
  if (family) return trTableKw(family, orifice, teC);

  const r404 = trTableKw('r404a', orifice, teC);
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

/** Corrección suave si Tc difiere del punto nominal de la tabla (38 °C). */
export function danfossCondensingFactor(condTempC: number): number {
  const tc = Number.isFinite(condTempC) ? condTempC : 38;
  return 1 + (tc - 38) * 0.012;
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

  const t2Overflow = t2.orifice === '06' && requiredKw > t2.rated * 0.98;
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
    if (cap >= requiredKw * 0.98) {
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
