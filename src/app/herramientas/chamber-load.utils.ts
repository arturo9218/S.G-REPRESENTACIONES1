/**
 * Estimación rápida de carga frigorífica por volumen (método de taller).
 * kcal/h·m³ → BTU/h → kW → HP comercial.
 */

export type ChamberUsagePreset = 'media_verduras' | 'media_generica' | 'baja_congelados' | 'custom';

export interface ChamberUsageDef {
  id: ChamberUsagePreset;
  label: string;
  kcalPerM3Default: number;
  kcalPerM3Min: number;
  kcalPerM3Max: number;
  panelNote: string;
}

export const CHAMBER_USAGE_PRESETS: readonly ChamberUsageDef[] = [
  {
    id: 'media_verduras',
    label: 'Verduras / lácteos (0 … 10 °C)',
    kcalPerM3Default: 110,
    kcalPerM3Min: 100,
    kcalPerM3Max: 120,
    panelNote: 'Paneles ~100 mm, media temperatura habitual.',
  },
  {
    id: 'media_generica',
    label: 'Media temperatura genérica (0 … 10 °C)',
    kcalPerM3Default: 110,
    kcalPerM3Min: 100,
    kcalPerM3Max: 120,
    panelNote: 'Regla rápida: 100–120 kcal/h·m³.',
  },
  {
    id: 'baja_congelados',
    label: 'Congelados (≈ −18 °C)',
    kcalPerM3Default: 200,
    kcalPerM3Min: 150,
    kcalPerM3Max: 250,
    panelNote: 'Regla rápida: 150–250 kcal/h·m³.',
  },
  {
    id: 'custom',
    label: 'Coeficiente manual (kcal/h·m³)',
    kcalPerM3Default: 110,
    kcalPerM3Min: 50,
    kcalPerM3Max: 300,
    panelNote: 'Ingresá el valor que uses en obra.',
  },
];

/** Referencia orientativa Danfoss MTZ (HP comercial aprox.). */
export const MTZ_COMPRESSOR_REF: readonly { model: string; hp: number }[] = [
  { model: 'MTZ28', hp: 1.5 },
  { model: 'MTZ32', hp: 2 },
  { model: 'MTZ36', hp: 2 },
  { model: 'MTZ44', hp: 3 },
  { model: 'MTZ56', hp: 4 },
  { model: 'MTZ64', hp: 5 },
  { model: 'MTZ80', hp: 6 },
];

export const KCAL_TO_BTU = 3.97;
export const KCAL_TO_KW = 1 / 860;
export const BTU_PER_HP_MIN = 9000;
export const BTU_PER_HP_NOM = 9500;
export const BTU_PER_HP_MAX = 10000;

export interface ChamberLoadStep {
  label: string;
  detail: string;
}

export interface ChamberCompressorHint {
  stressed: string | null;
  recommended: string;
  note: string;
}

export interface ChamberLoadResult {
  lengthM: number;
  widthM: number;
  heightM: number;
  volumeM3: number;
  exteriorTempC: number;
  interiorTempC: number;
  deltaTC: number;
  usageLabel: string;
  kcalPerM3: number;
  kcalPerM3Range: string;
  kcalH: number;
  btuH: number;
  kw: number;
  hpNom: number;
  hpRangeLabel: string;
  tr: number;
  steps: ChamberLoadStep[];
  compressor: ChamberCompressorHint;
  correctionsNote: string;
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('es-AR');
}

function suggestCompressor(hpLoad: number): ChamberCompressorHint {
  const sorted = [...MTZ_COMPRESSOR_REF].sort((a, b) => a.hp - b.hp);
  const recommended = sorted.find((c) => c.hp >= hpLoad) ?? sorted[sorted.length - 1];
  const below = sorted.filter((c) => c.hp < hpLoad);
  const stressedModel = below.length ? below[below.length - 1] : null;

  let note: string;
  if (recommended.hp >= hpLoad * 1.05) {
    note = `${recommended.model} (~${recommended.hp} HP) cubre la carga con margen razonable para mantenimiento.`;
  } else if (recommended.hp >= hpLoad) {
    note = `${recommended.model} (~${recommended.hp} HP) es el tamaño mínimo habitual; conviene no bajar de ahí.`;
  } else {
    note = `La carga supera la referencia MTZ listada; consultá catálogo para compresor mayor.`;
  }

  return {
    stressed: stressedModel ? `${stressedModel.model} (~${stressedModel.hp} HP)` : null,
    recommended: `${recommended.model} (~${recommended.hp} HP)`,
    note,
  };
}

export function estimateChamberLoad(input: {
  lengthM: number;
  widthM: number;
  heightM: number;
  exteriorTempC: number;
  interiorTempC: number;
  usage: ChamberUsagePreset;
  kcalPerM3Custom?: number;
}): ChamberLoadResult | null {
  const { lengthM: L, widthM: A, heightM: H } = input;
  if (!Number.isFinite(L) || !Number.isFinite(A) || !Number.isFinite(H) || L <= 0 || A <= 0 || H <= 0) {
    return null;
  }
  if (!Number.isFinite(input.exteriorTempC) || !Number.isFinite(input.interiorTempC)) return null;

  const preset = CHAMBER_USAGE_PRESETS.find((p) => p.id === input.usage) ?? CHAMBER_USAGE_PRESETS[0];
  let kcalPerM3 = preset.kcalPerM3Default;
  if (input.usage === 'custom') {
    const custom = input.kcalPerM3Custom;
    if (!Number.isFinite(custom) || custom! <= 0) return null;
    kcalPerM3 = custom!;
  }

  const volumeM3 = L * A * H;
  const deltaTC = input.exteriorTempC - input.interiorTempC;
  const kcalH = volumeM3 * kcalPerM3;
  const btuH = kcalH * KCAL_TO_BTU;
  const kw = kcalH * KCAL_TO_KW;
  const hpNom = btuH / BTU_PER_HP_NOM;
  const tr = kw / 3.517;

  const hpCommercialLow = Math.floor(hpNom * 2) / 2;
  const hpCommercialHigh = hpCommercialLow + 0.5;
  const hpRangeLabel = `${fmt(hpCommercialLow, 1)} – ${fmt(hpCommercialHigh, 1)} HP`;

  const steps: ChamberLoadStep[] = [
    {
      label: 'Volumen',
      detail: `${fmt(L, 1)} m × ${fmt(A, 1)} m × ${fmt(H, 1)} m = ${fmt(volumeM3, 1)} m³`,
    },
    {
      label: 'Diferencia térmica',
      detail: `${fmt(input.exteriorTempC, 0)} °C − ${fmt(input.interiorTempC, 0)} °C = ${fmt(deltaTC, 0)} °C (referencia; el método usa kcal/h·m³)`,
    },
    {
      label: 'Carga en kcal/h',
      detail: `${fmt(volumeM3, 1)} m³ × ${fmt(kcalPerM3, 0)} kcal/h·m³ = ${fmtInt(kcalH)} kcal/h`,
    },
    {
      label: 'BTU/h',
      detail: `${fmtInt(kcalH)} × ${KCAL_TO_BTU} = ${fmtInt(btuH)} BTU/h`,
    },
    {
      label: 'kW frigoríficos',
      detail: `${fmtInt(kcalH)} ÷ 860 = ${fmt(kw, 2)} kW`,
    },
    {
      label: 'HP comercial',
      detail: `${fmtInt(btuH)} ÷ ${BTU_PER_HP_NOM} ≈ ${fmt(hpNom, 2)} HP`,
    },
  ];

  return {
    lengthM: L,
    widthM: A,
    heightM: H,
    volumeM3,
    exteriorTempC: input.exteriorTempC,
    interiorTempC: input.interiorTempC,
    deltaTC,
    usageLabel: preset.label,
    kcalPerM3,
    kcalPerM3Range: `${preset.kcalPerM3Min}–${preset.kcalPerM3Max}`,
    kcalH,
    btuH,
    kw,
    hpNom,
    hpRangeLabel,
    tr,
    steps,
    compressor: suggestCompressor(hpNom),
    correctionsNote:
      'Orientativo sin pull-down ni picos de producto. Corregí después por: carga de mercadería, puertas, aislación, ubicación, renovación de aire y personal dentro.',
  };
}

/** Te evaporación orientativa para enlazar con dimensionado TXV. */
export function chamberEvapTempC(interiorTempC: number, usage: ChamberUsagePreset): number {
  if (usage === 'baja_congelados' || interiorTempC <= -10) {
    return Math.min(interiorTempC - 7, -25);
  }
  return interiorTempC - 10;
}
