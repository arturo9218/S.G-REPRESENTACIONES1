/**
 * Familias de válvula de expansión termostática Danfoss (catálogo orientativo).
 * T2/TE2: cartuchos 0X–06 (flare) — uso habitual en cámaras y comercio.
 * TUA/TUAE, TR6, TGE: otras líneas según conexión, refrigerante y carga.
 */

export type DanfossValveLineId = 't2_te2' | 'tua_tuae' | 'te5_tex' | 'tr6' | 'tge';

export type DanfossApplication = 'refrigeracion' | 'ac';

export interface DanfossValveLineInfo {
  id: DanfossValveLineId;
  name: string;
  bodies: string;
  orifices: string;
  connection: string;
  capacityKw: string;
  teRange: string;
  typicalUse: string;
}

export const DANFOSS_VALVE_LINES: readonly DanfossValveLineInfo[] = [
  {
    id: 't2_te2',
    name: 'T2 / TE2',
    bodies: 'T2 (equal. interna) · TE2 (equal. externa)',
    orifices: 'Cartuchos intercambiables 0X, 00, 01 … 06',
    connection: 'Flare 3/8" × 1/2" (o flare × soldadura con adaptador)',
    capacityKw: '≈ 0,6 – 23 kW (según refrigerante y Te)',
    teRange: '−40 … +10 °C (rangos N / NL / B del elemento)',
    typicalUse: 'Cámaras frías, vitrinas, equipos comerciales — la más usada en planta',
  },
  {
    id: 'tua_tuae',
    name: 'TUA / TUAE',
    bodies: 'TUA (equal. interna) · TUAE (equal. externa)',
    orifices: 'Cartuchos 0 … 9 (soldadura ODF)',
    connection: 'Soldadura ODF 3/8" × 1/2"',
    capacityKw: '≈ 0,1 – 16 kW',
    teRange: '−40 … +10 °C',
    typicalUse: 'Refrigeración con conexión soldada; transporte y autorfrigoríficos',
  },
  {
    id: 'te5_tex',
    name: 'TE5 / TEX (TE5 – TE55)',
    bodies: 'TE5 · TE12 · TE20 · TE55 (cuerpo crece con la carga)',
    orifices: 'Orificios 0,5 … 13 (soldadura ODF, elemento rango N)',
    connection: 'Soldadura ODF · equalización externa habitual',
    capacityKw: '≈ 3 – 200 kW (según cuerpo, orificio y Te)',
    teRange: '−40 … +10 °C (elemento rango N)',
    typicalUse: 'Refrigeración comercial y plantas medianas — segunda línea habitual en taller junto a T2/TE2',
  },
  {
    id: 'tr6',
    name: 'TR6',
    bodies: 'TR6 (cuerpo único, cabeza soldada)',
    orifices: 'Orificio fijo 3 … 7 (no intercambiable)',
    connection: 'Soldadura ODF 3/8" × 3/8" · kits con accesorios',
    capacityKw: '≈ 10 – 24 kW (3 – 7 TR)',
    teRange: '≈ −9 … +15 °C',
    typicalUse: 'Aire acondicionado, splits, rooftops, bombas de calor (R410A, R407C, R22)',
  },
  {
    id: 'tge',
    name: 'TGE',
    bodies: 'TGEX · TGEL · TGEN · TGES (según refrigerante y carga)',
    orifices: 'Válvula completa por tamaño (puerto balanceado, sin cartucho 0X)',
    connection: 'Soldadura ODF, vários diámetros',
    capacityKw: '≈ 32 – 160 kW (9 – 46 TR)',
    teRange: 'Refrigeración −40 … +10 °C · A/C −30 … +15 °C',
    typicalUse: 'Grandes equipos, chillers, plantas de capacidad media-alta',
  },
];

/** Orificios TR6 (capacidad nominal R410A en TR, catálogo Danfoss). */
const TR6_ORIFICES_R410A: { orifice: string; tr: number }[] = [
  { orifice: '3', tr: 3.2 },
  { orifice: '4', tr: 4.5 },
  { orifice: '5', tr: 5.4 },
  { orifice: '6', tr: 5.6 },
  { orifice: '7', tr: 6.8 },
];

/** Referencia TGE refrigeración R404A/R507 (TGES, tons nominales). */
const TGE_R404A: { model: string; tr: number }[] = [
  { model: 'TGES 10 HFES-5S', tr: 5 },
  { model: 'TGES 10 HFES-7S', tr: 7 },
  { model: 'TGES 20 TRAE-8S', tr: 9 },
  { model: 'TGES 20 HFES-10S', tr: 11 },
  { model: 'TGES 20 HFES-13S', tr: 13 },
  { model: 'TGES 20 TRAE-20S', tr: 21 },
];

const AC_REFRIGERANTS = new Set(['r410a', 'r407c', 'r407a', 'r407f', 'r22', 'r454a', 'r454b']);

export interface DanfossLinePick {
  line: DanfossValveLineId;
  label: string;
  reason: string;
  alternatives: string[];
}

export function pickDanfossValveLine(input: {
  requiredKw: number;
  evapTempC: number;
  refrigerantId: string;
  application: DanfossApplication;
  externalEqualization: boolean;
  t2MaxOrificeInsufficient: boolean;
}): DanfossLinePick {
  const kw = input.requiredKw;
  const tr = kw / 3.517;
  const te = input.evapTempC;
  const ref = input.refrigerantId;
  const eq = input.externalEqualization ? 'TE2 / TUAE' : 'T2 / TUA';

  const alternatives: string[] = [];

  if (kw > 22 || input.t2MaxOrificeInsufficient) {
    if (kw >= 30) {
      const tge = selectTgeModel(tr);
      return {
        line: 'tge',
        label: 'TGE',
        reason:
          kw >= 30
            ? `Carga ~${kw.toFixed(1)} kW (${tr.toFixed(1)} TR): supera la línea T2/TE2 (cartucho 06). Corresponde válvula ${tge}.`
            : 'La carga supera el cartucho 06 de T2/TE2; pasá a la línea TGE.',
        alternatives: [
          'Confirmá en Coolselector®2 el modelo TGEX / TGEL / TGEN / TGES exacto.',
          'Para cargas intermedias (≈15–25 kW) en A/C, evaluá también TR6 si aplica.',
        ],
      };
    }
    alternatives.push('Línea TGE si la carga sigue creciendo (>30 kW).');
  }

  if (
    input.application === 'ac' &&
    AC_REFRIGERANTS.has(ref) &&
    te >= -9 &&
    te <= 15 &&
    kw >= 9 &&
    kw <= 26
  ) {
    alternatives.push(`Alternativa A/C: TR6 con orificio ${selectTr6Orifice(tr)} (soldadura, R410A/R407C).`);
    if (kw >= 9 && kw <= 26 && (ref === 'r410a' || ref === 'r407c' || ref === 'r22')) {
      return {
        line: 'tr6',
        label: 'TR6',
        reason: `Aplicación de aire acondicionado (~${te.toFixed(0)} °C evaporación, ${kw.toFixed(1)} kW): la línea TR6 es la habitual (orificios 3–7, kits).`,
        alternatives: [
          'Para cámara fría con R404A/R448A preferí T2/TE2 aunque la carga sea similar.',
          ...alternatives,
        ],
      };
    }
  }

  alternatives.push('Con conexión soldada ODF: TUA/TUAE (orificios 0–9) o línea TE5/TEX (orificios 0,5–13).');
  if (input.externalEqualization) {
    alternatives.push('Con distribuidor: TE2 (T2/TE2) o TUAE (TUA).');
  }

  return {
    line: 't2_te2',
    label: 'T2 / TE2',
    reason: `Refrigeración comercial (~${kw.toFixed(1)} kW a Te ${te.toFixed(0)} °C): línea ${eq} con cartucho 0X–06 (Danfoss más usada en planta).`,
    alternatives,
  };
}

export function selectTr6Orifice(requiredTr: number): string {
  for (const row of TR6_ORIFICES_R410A) {
    if (row.tr >= requiredTr * 0.98) return row.orifice;
  }
  return '7';
}

export function selectTgeModel(requiredTr: number): string {
  for (const row of TGE_R404A) {
    if (row.tr >= requiredTr * 0.95) return row.model;
  }
  return 'TGES 20 TRAE-20S o superior (consultar catálogo)';
}

export function tr6OrificeHint(requiredKw: number): { orifice: string; trNominal: number } {
  const tr = requiredKw / 3.517;
  const orifice = selectTr6Orifice(tr);
  const row = TR6_ORIFICES_R410A.find((r) => r.orifice === orifice);
  return { orifice, trNominal: row?.tr ?? tr };
}

export function tgeModelHint(requiredKw: number): { model: string; trNominal: number } {
  const tr = requiredKw / 3.517;
  const model = selectTgeModel(tr);
  const row = TGE_R404A.find((r) => r.model === model);
  return { model, trNominal: row?.tr ?? tr };
}
