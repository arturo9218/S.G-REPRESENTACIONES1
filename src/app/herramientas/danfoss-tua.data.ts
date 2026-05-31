/**
 * Danfoss TUA / TUAE — cartuchos 0 … 9, conexión soldadura ODF.
 * Tablas orientativas catálogo Danfoss (Tc ≈ 38 °C, igual criterio que T2/TE2).
 */

import {
  DANFOSS_EVAP_TEMP_C,
  danfossFamilyForRefrigerant,
  type DanfossRefFamily,
} from './danfoss-t2-te2.data';

export type DanfossTuaOrificeId = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

export interface DanfossTuaOrificeDef {
  id: DanfossTuaOrificeId;
  orificeCode: string;
}

export const DANFOSS_TUA_ORIFICES: readonly DanfossTuaOrificeDef[] = [
  { id: '0', orificeCode: '068U1030' },
  { id: '1', orificeCode: '068U1031' },
  { id: '2', orificeCode: '068U1032' },
  { id: '3', orificeCode: '068U1033' },
  { id: '4', orificeCode: '068U1034' },
  { id: '5', orificeCode: '068U1035' },
  { id: '6', orificeCode: '068U1036' },
  { id: '7', orificeCode: '068U1037' },
  { id: '8', orificeCode: '068U1038' },
  { id: '9', orificeCode: '068U1039' },
];

const TR_TO_KW = 3.517;

/** Capacidad TR vs Te — R-404A (catálogo Danfoss). */
const TUA_TR_R404A: Record<DanfossTuaOrificeId, readonly number[]> = {
  '0': [1 / 8, 1 / 15, 1 / 15, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 6, 1 / 5, 1 / 5],
  '1': [1 / 5, 1 / 15, 1 / 15, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 6, 1 / 5, 1 / 5],
  '2': [1 / 4, 1 / 15, 1 / 15, 1 / 10, 1 / 8, 1 / 6, 1 / 5, 1 / 5, 1 / 4, 1 / 4],
  '3': [1 / 3, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3],
  '4': [1 / 2, 1 / 6, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2],
  '5': [3 / 4, 1 / 5, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2, 3 / 4, 3 / 4],
  '6': [1, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1],
  '7': [1.5, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 1, 1, 4 / 3, 1.5, 1.5],
  '8': [2, 1 / 3, 1 / 2, 3 / 4, 1, 1, 4 / 3, 1.5, 2, 2 + 1 / 3],
  '9': [3 + 1 / 3, 3 / 4, 1, 1, 4 / 3, 1.5, 2, 2.5, 3, 3.5],
};

const TUA_TR: Record<DanfossRefFamily, Record<DanfossTuaOrificeId, readonly number[]>> = {
  r404a: TUA_TR_R404A,
  r134a: {
    '0': [1 / 8, 1 / 30, 1 / 15, 1 / 15, 1 / 10, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 6],
    '1': [1 / 6, 1 / 15, 1 / 15, 1 / 10, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 6, 1 / 5],
    '2': [1 / 5, 1 / 15, 1 / 15, 1 / 10, 1 / 8, 1 / 6, 1 / 6, 1 / 5, 1 / 5, 1 / 5],
    '3': [1 / 4, 1 / 15, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 5, 1 / 5, 1 / 4, 1 / 4],
    '4': [1 / 3, 1 / 8, 1 / 6, 1 / 5, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 2],
    '5': [1 / 2, 1 / 5, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2],
    '6': [3 / 4, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1],
    '7': [1, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1 + 1 / 4],
    '8': [1.75, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 4, 1 + 1 / 3, 1.5],
    '9': [2, 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 1.75, 2, 2 + 1 / 3, 2 + 3 / 4],
  },
  r407c: {
    '0': [1 / 6, 1 / 15, 1 / 15, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 6, 1 / 5, 1 / 5],
    '1': [1 / 5, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 6, 1 / 5, 1 / 5, 1 / 4, 1 / 4],
    '2': [1 / 4, 1 / 10, 1 / 8, 1 / 8, 1 / 6, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3],
    '3': [1 / 3, 1 / 8, 1 / 6, 1 / 5, 1 / 5, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 3],
    '4': [1 / 2, 1 / 4, 1 / 4, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 1 / 2, 3 / 4, 3 / 4],
    '5': [3 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 3 / 4, 1],
    '6': [1, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 3],
    '7': [2, 1 / 2, 3 / 4, 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 1.75, 2],
    '8': [2 + 3 / 4, 1, 1, 1 + 1 / 3, 1.5, 2, 2 + 1 / 3, 2.5, 3, 3],
    '9': [4, 1 + 1 / 3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5],
  },
  r22: TUA_TR_R404A,
  r448a: TUA_TR_R404A,
  r449a: TUA_TR_R404A,
};

export interface DanfossTuaSelection {
  valveBody: 'TUA' | 'TUAE';
  orifice: DanfossTuaOrificeId;
  orificeCode: string;
  ratedCapacityKw: number;
  summary: string;
  fichaText: string;
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

function tuaCapacityKw(refrigerantId: string, orifice: DanfossTuaOrificeId, teC: number): number | null {
  const family = danfossFamilyForRefrigerant(refrigerantId);
  if (family) {
    const tr = interpolateAtTemp(TUA_TR[family][orifice], teC);
    return tr * TR_TO_KW;
  }
  const r404 = interpolateAtTemp(TUA_TR_R404A[orifice], teC) * TR_TO_KW;
  const scaleByRef: Record<string, number> = {
    r410a: 1.05,
    r32: 1.08,
    r454a: 1.05,
    r454b: 1.04,
    r290: 0.55,
    r600a: 0.35,
    r717: 0.75,
  };
  const scale = scaleByRef[refrigerantId];
  if (scale == null) return null;
  return r404 * scale;
}

/** Alternativa soldadura TUA/TUAE (misma carga que T2/TE2). */
export function selectTuaTuaeAlternative(input: {
  refrigerantId: string;
  evapTempC: number;
  requiredKw: number;
  externalEqualization: boolean;
}): DanfossTuaSelection | null {
  const required = input.requiredKw;
  if (!Number.isFinite(required) || required <= 0 || required > 18) return null;

  let selected: DanfossTuaOrificeId | null = null;
  let rated = 0;

  for (const row of DANFOSS_TUA_ORIFICES) {
    const cap = tuaCapacityKw(input.refrigerantId, row.id, input.evapTempC);
    if (cap == null) return null;
    if (cap >= required * 0.98) {
      selected = row.id;
      rated = cap;
      break;
    }
  }

  if (!selected) {
    selected = '9';
    rated = tuaCapacityKw(input.refrigerantId, '9', input.evapTempC) ?? 0;
    if (required > rated * 1.02) return null;
  }

  const body = input.externalEqualization ? 'TUAE' : 'TUA';
  const code = DANFOSS_TUA_ORIFICES.find((o) => o.id === selected)!.orificeCode;
  const fichaText = `Danfoss ${body} · orif. ${selected} · ${code}`;

  return {
    valveBody: body,
    orifice: selected,
    orificeCode: code,
    ratedCapacityKw: rated,
    summary: `${body} · orificio ${selected} (${code}) · ~${rated.toFixed(1)} kW · soldadura ODF 3/8"×1/2"`,
    fichaText,
  };
}
