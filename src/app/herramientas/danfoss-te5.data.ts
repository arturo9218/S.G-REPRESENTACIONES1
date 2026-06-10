/**
 * Danfoss TE5 – TE55 (TEX5 … TEX55) — soldadura ODF, elemento rango N.
 * Nominales orificios 0,5–4: R-134a y R-407C (catálogo Danfoss, kW).
 * Resto: tablas orientativas R-404A/R507, recal. apertura 4 K.
 */

import {
  danfossDistributorFactor,
  danfossFamilyForRefrigerant,
  danfossSubcoolingFactor,
  type DanfossRefFamily,
} from './danfoss-t2-te2.data';

export type DanfossTe5OrificeId =
  | '0.5'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | '11'
  | '12'
  | '13';

export type DanfossTe5Body = 'TE5' | 'TE12' | 'TE20' | 'TE55';

export interface DanfossTe5OrificeDef {
  id: DanfossTe5OrificeId;
  body: DanfossTe5Body;
  orificeCode: string;
  /** Nombre comercial habitual (TEX = TE en algunos mercados). */
  commercialBody: string;
}

/** Columnas de evaporación en tablas TE5–TE55 rango N (°C). */
export const TE5_EVAP_TEMP_C = [-40, -35, -30, -25, -20, -15, -10, -5, 0, 5, 10] as const;

const TC_ANCHORS_C = [25, 35, 45, 55] as const;

export const DANFOSS_TE5_ORIFICES: readonly DanfossTe5OrificeDef[] = [
  { id: '0.5', body: 'TE5', orificeCode: '067B2788', commercialBody: 'TE5 / TEX5' },
  { id: '1', body: 'TE5', orificeCode: '067B2789', commercialBody: 'TE5 / TEX5' },
  { id: '2', body: 'TE5', orificeCode: '067B2790', commercialBody: 'TE5 / TEX5' },
  { id: '3', body: 'TE5', orificeCode: '067B2791', commercialBody: 'TE5 / TEX5' },
  { id: '4', body: 'TE5', orificeCode: '067B2792', commercialBody: 'TE5 / TEX5' },
  { id: '5', body: 'TE12', orificeCode: '067B2708', commercialBody: 'TE12 / TEX12' },
  { id: '6', body: 'TE12', orificeCode: '067B2709', commercialBody: 'TE12 / TEX12' },
  { id: '7', body: 'TE12', orificeCode: '067B2710', commercialBody: 'TE12 / TEX12' },
  { id: '8', body: 'TE20', orificeCode: '067B2771', commercialBody: 'TE20 / TEX20' },
  { id: '9', body: 'TE20', orificeCode: '067B2773', commercialBody: 'TE20 / TEX20' },
  { id: '10', body: 'TE55', orificeCode: '067G2701', commercialBody: 'TE55 / TEX55' },
  { id: '11', body: 'TE55', orificeCode: '067G2704', commercialBody: 'TE55 / TEX55' },
  { id: '12', body: 'TE55', orificeCode: '067G2707', commercialBody: 'TE55 / TEX55' },
  { id: '13', body: 'TE55', orificeCode: '067G2710', commercialBody: 'TE55 / TEX55' },
];

/** Capacidad nominal kW a Te +4,4 °C, Tc 38 °C (catálogo Danfoss). */
const TE5_NOMINAL_KW: Record<DanfossRefFamily, Record<DanfossTe5OrificeId, number>> = {
  r404a: {
    '0.5': 8.17,
    '1': 14.9,
    '2': 20.5,
    '3': 26.3,
    '4': 35.7,
    '5': 50.7,
    '6': 64.0,
    '7': 81.3,
    '8': 87.1,
    '9': 102.0,
    '10': 128.0,
    '11': 138.0,
    '12': 152.0,
    '13': 182.0,
  },
  r134a: {
    '0.5': 6.68,
    '1': 12.2,
    '2': 17.0,
    '3': 21.8,
    '4': 29.7,
    '5': 37.7,
    '6': 50.1,
    '7': 65.7,
    '8': 77.8,
    '9': 92.3,
    '10': 111.0,
    '11': 122.0,
    '12': 134.0,
    '13': 166.0,
  },
  r407c: {
    '0.5': 10.7,
    '1': 19.6,
    '2': 27.2,
    '3': 34.8,
    '4': 47.4,
    '5': 55.8,
    '6': 73.9,
    '7': 94.3,
    '8': 118.0,
    '9': 136.0,
    '10': 161.0,
    '11': 175.0,
    '12': 191.0,
    '13': 232.0,
  },
  r22: {
    '0.5': 10.4,
    '1': 19.1,
    '2': 26.3,
    '3': 33.8,
    '4': 46.0,
    '5': 57.2,
    '6': 76.3,
    '7': 97.8,
    '8': 128.0,
    '9': 150.0,
    '10': 169.0,
    '11': 184.0,
    '12': 202.0,
    '13': 245.0,
  },
  r448a: {
    '0.5': 8.17,
    '1': 14.9,
    '2': 20.5,
    '3': 26.3,
    '4': 35.7,
    '5': 50.7,
    '6': 64.0,
    '7': 81.3,
    '8': 87.1,
    '9': 102.0,
    '10': 128.0,
    '11': 138.0,
    '12': 152.0,
    '13': 182.0,
  },
  r449a: {
    '0.5': 8.17,
    '1': 14.9,
    '2': 20.5,
    '3': 26.3,
    '4': 35.7,
    '5': 50.7,
    '6': 64.0,
    '7': 81.3,
    '8': 87.1,
    '9': 102.0,
    '10': 128.0,
    '11': 138.0,
    '12': 152.0,
    '13': 182.0,
  },
};

type Te5Table = Record<DanfossTe5OrificeId, readonly number[]>;

/** R404A kW vs Te por Tc de condensación (tablas Danfoss TE5–TE55). */
const TE5_KW_R404A: Record<(typeof TC_ANCHORS_C)[number], Te5Table> = {
  25: {
    '0.5': [3.68, 4.21, 4.77, 5.34, 5.91, 6.45, 6.93, 7.31, 7.54, 7.55, 7.3],
    '1': [6.76, 7.74, 8.76, 9.8, 10.84, 11.82, 12.68, 13.35, 13.73, 13.72, 13.21],
    '2': [9.49, 10.86, 12.28, 13.71, 15.12, 16.43, 17.55, 18.39, 18.81, 18.68, 17.88],
    '3': [11.99, 13.76, 15.6, 17.49, 19.35, 21.11, 22.64, 23.79, 24.4, 24.29, 23.28],
    '4': [16.09, 18.54, 21.09, 23.7, 26.28, 28.7, 30.8, 32.3, 33.1, 32.8, 31.2],
    '5': [20.72, 24.17, 27.9, 31.9, 36.0, 40.1, 43.9, 47.0, 48.9, 49.1, 47.2],
    '6': [24.92, 29.31, 34.1, 39.2, 44.5, 49.9, 54.9, 59.1, 61.7, 62.1, 59.6],
    '7': [32.5, 37.9, 43.9, 50.6, 57.6, 64.9, 72.0, 78.0, 81.0, 82.0, 78.0],
    '8': [35.7, 41.8, 48.4, 55.2, 62.2, 69.1, 75.0, 80.0, 83.0, 83.0, 80.0],
    '9': [39.5, 46.5, 54.2, 62.5, 71.0, 80.0, 88.0, 95.0, 100.0, 101.0, 97.0],
    '10': [46.5, 55.3, 64.9, 75.0, 86.0, 97.0, 108.0, 117.0, 124.0, 127.0, 125.0],
    '11': [51.1, 60.7, 71.0, 83.0, 94.0, 107.0, 118.0, 128.0, 136.0, 139.0, 135.0],
    '12': [54.8, 65.3, 77.0, 89.0, 103.0, 116.0, 130.0, 142.0, 151.0, 155.0, 152.0],
    '13': [66.5, 79.0, 94.0, 109.0, 126.0, 143.0, 159.0, 173.0, 183.0, 187.0, 181.0],
  },
  35: {
    '0.5': [3.45, 3.98, 4.55, 5.15, 5.78, 6.42, 7.05, 7.63, 8.12, 8.46, 8.61],
    '1': [6.34, 7.32, 8.37, 9.48, 10.63, 11.8, 12.93, 13.98, 14.84, 15.43, 15.64],
    '2': [8.9, 10.28, 11.75, 13.29, 14.88, 16.47, 17.99, 19.35, 20.44, 21.12, 21.27],
    '3': [11.14, 12.88, 14.76, 16.74, 18.8, 20.89, 22.92, 24.76, 26.25, 27.22, 27.49],
    '4': [14.85, 17.27, 19.87, 22.63, 25.5, 28.4, 31.2, 33.7, 35.7, 36.9, 37.1],
    '5': [18.65, 21.82, 25.33, 29.17, 33.3, 37.8, 42.3, 46.7, 50.5, 53.3, 54.4],
    '6': [22.27, 26.29, 30.7, 35.7, 41.0, 46.8, 52.7, 58.5, 63.6, 67.3, 68.7],
    '7': [27.84, 32.6, 37.9, 44.0, 50.7, 58.1, 66.0, 74.0, 81.0, 87.0, 89.0],
    '8': [32.4, 38.0, 44.3, 51.1, 58.3, 66.0, 74.0, 81.0, 87.0, 91.0, 93.0],
    '9': [34.9, 41.1, 48.2, 56.0, 64.6, 74.0, 84.0, 93.0, 101.0, 108.0, 110.0],
    '10': [40.6, 48.7, 57.7, 67.7, 79.0, 90.0, 103.0, 115.0, 126.0, 136.0, 141.0],
    '11': [44.2, 53.1, 62.9, 74.0, 86.0, 98.0, 112.0, 125.0, 137.0, 147.0, 153.0],
    '12': [47.1, 56.6, 67.2, 79.0, 92.0, 106.0, 121.0, 136.0, 150.0, 162.0, 170.0],
    '13': [56.0, 67.5, 80.0, 95.0, 111.0, 128.0, 146.0, 165.0, 181.0, 195.0, 202.0],
  },
  45: {
    '0.5': [3.08, 3.57, 4.11, 4.7, 5.32, 5.99, 6.67, 7.36, 8.02, 8.6, 9.05],
    '1': [5.65, 6.57, 7.57, 8.65, 9.81, 11.03, 12.29, 13.54, 14.73, 15.76, 16.53],
    '2': [7.94, 9.25, 10.66, 12.18, 13.79, 15.47, 17.19, 18.88, 20.43, 21.74, 22.65],
    '3': [9.85, 11.46, 13.22, 15.12, 17.17, 19.33, 21.57, 23.8, 25.89, 27.68, 28.97],
    '4': [13.04, 15.28, 17.72, 20.38, 23.25, 26.28, 29.41, 32.5, 35.4, 37.7, 39.3],
    '5': [16.09, 18.84, 21.89, 25.29, 29.07, 33.2, 37.8, 42.6, 47.4, 51.8, 55.3],
    '6': [19.05, 22.51, 26.38, 30.7, 35.6, 41.0, 46.9, 53.2, 59.6, 65.5, 70.0],
    '7': [23.11, 26.97, 31.3, 36.3, 42.0, 48.4, 55.7, 63.6, 72.0, 80.0, 87.0],
    '8': [28.01, 32.9, 38.4, 44.5, 51.3, 58.7, 66.6, 75.0, 83.0, 90.0, 95.0],
    '9': [29.49, 34.8, 40.7, 47.4, 55.0, 63.6, 73.0, 83.0, 93.0, 103.0, 110.0],
    '10': [33.4, 40.5, 48.5, 57.4, 67.4, 79.0, 91.0, 104.0, 117.0, 129.0, 140.0],
    '11': [36.2, 43.9, 52.5, 62.1, 73.0, 85.0, 98.0, 112.0, 126.0, 139.0, 151.0],
    '12': [38.2, 46.4, 55.5, 65.9, 78.0, 91.0, 105.0, 120.0, 136.0, 151.0, 165.0],
    '13': [44.6, 54.3, 65.3, 78.0, 92.0, 107.0, 125.0, 143.0, 162.0, 181.0, 196.0],
  },
  55: {
    '0.5': [2.6, 3.03, 3.5, 4.01, 4.57, 5.18, 5.83, 6.51, 7.2, 7.88, 8.5],
    '1': [4.76, 5.57, 6.44, 7.4, 8.45, 9.57, 10.77, 12.03, 13.31, 14.54, 15.65],
    '2': [6.69, 7.85, 9.1, 10.46, 11.94, 13.52, 15.19, 16.91, 18.64, 20.27, 21.68],
    '3': [8.31, 9.77, 11.28, 12.92, 14.7, 16.62, 18.65, 20.75, 22.85, 24.85, 26.6],
    '4': [11.0, 12.92, 15.0, 17.3, 19.8, 22.6, 25.5, 28.4, 31.2, 33.8, 35.8],
    '5': [13.6, 16.0, 18.6, 21.5, 24.7, 28.2, 32.0, 36.0, 40.0, 44.0, 47.0],
    '6': [16.1, 19.0, 22.2, 25.8, 29.8, 34.2, 39.0, 44.0, 49.0, 54.0, 58.0],
    '7': [19.5, 22.8, 26.6, 31.0, 35.8, 41.0, 47.0, 53.0, 59.0, 65.0, 70.0],
    '8': [23.5, 27.5, 32.0, 37.2, 43.0, 49.5, 56.5, 64.0, 71.0, 78.0, 84.0],
    '9': [24.7, 29.0, 33.8, 39.4, 45.6, 52.5, 60.0, 68.0, 76.0, 84.0, 91.0],
    '10': [28.0, 33.0, 38.5, 45.0, 52.0, 60.0, 68.0, 77.0, 86.0, 95.0, 103.0],
    '11': [30.2, 35.6, 41.6, 48.6, 56.4, 65.0, 74.0, 84.0, 94.0, 104.0, 113.0],
    '12': [31.8, 37.6, 44.0, 51.4, 59.8, 69.0, 79.0, 90.0, 101.0, 112.0, 122.0],
    '13': [37.0, 44.0, 51.5, 60.5, 70.5, 81.5, 93.5, 106.0, 119.0, 132.0, 144.0],
  },
};

export interface DanfossTe5Selection {
  valveBody: DanfossTe5Body;
  commercialBody: string;
  orifice: DanfossTe5OrificeId;
  orificeCode: string;
  ratedCapacityKw: number;
  requiredCapacityKw: number;
  elementRangeLabel: string;
  summary: string;
  fichaText: string;
  estimatedRefrigerant: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolateAtTemp(values: readonly number[], teC: number): number {
  const xs = TE5_EVAP_TEMP_C;
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

function familyScale(family: DanfossRefFamily, orifice: DanfossTe5OrificeId): number {
  const r404 = TE5_NOMINAL_KW.r404a[orifice];
  return TE5_NOMINAL_KW[family][orifice] / r404;
}

function te5CapacityR404AtTc(orifice: DanfossTe5OrificeId, teC: number, tcC: number): number {
  const tc = Math.max(TC_ANCHORS_C[0], Math.min(TC_ANCHORS_C[TC_ANCHORS_C.length - 1], tcC));
  let loTc: (typeof TC_ANCHORS_C)[number] = TC_ANCHORS_C[0];
  let hiTc: (typeof TC_ANCHORS_C)[number] = TC_ANCHORS_C[TC_ANCHORS_C.length - 1];
  for (let i = 0; i < TC_ANCHORS_C.length - 1; i++) {
    if (tc <= TC_ANCHORS_C[i + 1]) {
      loTc = TC_ANCHORS_C[i];
      hiTc = TC_ANCHORS_C[i + 1];
      break;
    }
  }
  const t = hiTc === loTc ? 0 : (tc - loTc) / (hiTc - loTc);
  const loKw = interpolateAtTemp(TE5_KW_R404A[loTc][orifice], teC);
  const hiKw = interpolateAtTemp(TE5_KW_R404A[hiTc][orifice], teC);
  return lerp(loKw, hiKw, t);
}

function te5CapacityKw(
  refrigerantId: string,
  orifice: DanfossTe5OrificeId,
  teC: number,
  tcC: number
): number | null {
  const family = danfossFamilyForRefrigerant(refrigerantId);
  const base = te5CapacityR404AtTc(orifice, teC, tcC);
  if (family) return base * familyScale(family, orifice);

  const r404 = base;
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

/** Segunda recomendación de taller: línea TE5 / TEX (elemento rango N, soldadura ODF). */
export function selectTe5TexLine(input: {
  refrigerantId: string;
  capacityKw: number;
  evapTempC: number;
  condTempC: number;
  subcoolingK: number;
  distributorDropBar: number;
}): DanfossTe5Selection | null {
  const te = input.evapTempC;
  if (!Number.isFinite(te) || te < -40 || te > 10) return null;

  const q = input.capacityKw;
  if (!Number.isFinite(q) || q <= 0) return null;

  const fsub = danfossSubcoolingFactor(input.subcoolingK);
  const fp = danfossDistributorFactor(input.distributorDropBar);
  const required = q / (fsub * fp);

  let selected: DanfossTe5OrificeDef | null = null;
  let rated = 0;

  for (const row of DANFOSS_TE5_ORIFICES) {
    const cap = te5CapacityKw(input.refrigerantId, row.id, te, input.condTempC);
    if (cap == null) return null;
    if (cap >= required * 0.98) {
      selected = row;
      rated = cap;
      break;
    }
  }

  if (!selected) {
    const last = DANFOSS_TE5_ORIFICES[DANFOSS_TE5_ORIFICES.length - 1];
    rated = te5CapacityKw(input.refrigerantId, last.id, te, input.condTempC) ?? 0;
    if (required > rated * 1.02) return null;
    selected = last;
  }

  const estimated = danfossFamilyForRefrigerant(input.refrigerantId) == null;
  const fichaText = `Danfoss ${selected.body} · orif. ${selected.id} · ${selected.orificeCode} · rango N`;
  const summary = `${selected.commercialBody} · cuerpo ${selected.body} · orificio ${selected.id} (${selected.orificeCode}) · ~${rated.toFixed(1)} kW · equalización externa · soldadura ODF`;

  return {
    valveBody: selected.body,
    commercialBody: selected.commercialBody,
    orifice: selected.id,
    orificeCode: selected.orificeCode,
    ratedCapacityKw: rated,
    requiredCapacityKw: required,
    elementRangeLabel: 'Rango N (−40 a +10 °C)',
    summary,
    fichaText,
    estimatedRefrigerant: estimated,
  };
}
