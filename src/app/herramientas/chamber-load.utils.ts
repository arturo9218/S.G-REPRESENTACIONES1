/**
 * Carga frigorífica de cámara — método de taller.
 * Total = paredes + producto + infiltración (puerta) + motores/luces + margen de seguridad.
 * Orientativo; validar con proyecto y catálogo de equipos.
 */

export type ChamberProductType = 'verdura' | 'carne' | 'lacteos' | 'congelado' | 'ninguno';

export type ChamberInsulationPreset = 'pu_50' | 'pu_80' | 'pu_100' | 'pu_120' | 'mamposteria' | 'custom_u';

export type ChamberDoorUsage = 'poco' | 'medio' | 'mucho';

/** @deprecated Usar producto + aislación; se mantiene para enlazar TXV. */
export type ChamberUsagePreset = 'media_verduras' | 'media_generica' | 'baja_congelados' | 'custom';

export interface ChamberUsageDef {
  id: ChamberUsagePreset;
  label: string;
  kcalPerM3Default: number;
  kcalPerM3Min: number;
  kcalPerM3Max: number;
  panelNote: string;
}

/** Regla rápida m³ (solo referencia / modo rápido). */
export const CHAMBER_USAGE_PRESETS: readonly ChamberUsageDef[] = [
  {
    id: 'media_verduras',
    label: 'Verduras / frutas (5 … 10 °C)',
    kcalPerM3Default: 105,
    kcalPerM3Min: 80,
    kcalPerM3Max: 130,
    panelNote: 'Regla rápida: 80–130 kcal/h·m³.',
  },
  {
    id: 'media_generica',
    label: 'Carne / lácteos (0 … 2 °C)',
    kcalPerM3Default: 150,
    kcalPerM3Min: 120,
    kcalPerM3Max: 180,
    panelNote: 'Regla rápida: 120–180 kcal/h·m³.',
  },
  {
    id: 'baja_congelados',
    label: 'Congelado (≈ −18 °C)',
    kcalPerM3Default: 325,
    kcalPerM3Min: 250,
    kcalPerM3Max: 400,
    panelNote: 'Regla rápida: 250–400 kcal/h·m³.',
  },
  {
    id: 'custom',
    label: 'Coeficiente manual (kcal/h·m³)',
    kcalPerM3Default: 110,
    kcalPerM3Min: 50,
    kcalPerM3Max: 400,
    panelNote: 'Solo modo rápido.',
  },
];

export const CHAMBER_PRODUCT_TYPES: readonly { id: ChamberProductType; label: string; cpKcal: number }[] = [
  { id: 'verdura', label: 'Verduras / frutas', cpKcal: 0.92 },
  { id: 'carne', label: 'Carne', cpKcal: 0.8 },
  { id: 'lacteos', label: 'Lácteos', cpKcal: 0.92 },
  { id: 'congelado', label: 'Producto a congelar', cpKcal: 0.85 },
  { id: 'ninguno', label: 'Sin carga de producto', cpKcal: 0 },
];

/** K = transmitancia en kcal/(h·m²·°C) — Q = K × A × ΔT (fórmula de taller). */
export const CHAMBER_INSULATION_PRESETS: readonly {
  id: ChamberInsulationPreset;
  label: string;
  kKcalHm2C: number;
}[] = [
  { id: 'pu_50', label: 'Poliuretano 50 mm (catálogo)', kKcalHm2C: 0.4 },
  { id: 'pu_80', label: 'Poliuretano 80 mm (catálogo)', kKcalHm2C: 0.28 },
  { id: 'pu_100', label: 'Poliuretano 100 mm (catálogo)', kKcalHm2C: 0.22 },
  { id: 'pu_120', label: 'Poliuretano 120 mm (catálogo)', kKcalHm2C: 0.18 },
  {
    id: 'mamposteria',
    label: 'Cámara instalada / puentes térmicos (~100 mm real)',
    kKcalHm2C: 0.85,
  },
  { id: 'custom_u', label: 'K manual (kcal/h·m²·°C)', kKcalHm2C: 0 },
];

export const CHAMBER_DOOR_USAGE: readonly { id: ChamberDoorUsage; label: string; pct: number }[] = [
  { id: 'poco', label: 'Pocas aperturas (10–15 %)', pct: 0.125 },
  { id: 'medio', label: 'Uso medio (20–30 %)', pct: 0.25 },
  { id: 'mucho', label: 'Muchas aperturas (35–50 %)', pct: 0.425 },
];

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
export const W_TO_KCAL_H = 0.86;
export const BTU_PER_HP_NOM = 9500;

export interface ChamberLoadStep {
  label: string;
  detail: string;
}

export interface ChamberLoadBreakdown {
  wallsKcalH: number;
  productKcalH: number;
  infiltrationKcalH: number;
  internalKcalH: number;
  subtotalKcalH: number;
  safetyMarginKcalH: number;
  totalKcalH: number;
  /** Modo rápido m³ (referencia). */
  quickRuleKcalH?: number;
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
  surfaceM2: number;
  exteriorTempC: number;
  interiorTempC: number;
  deltaTC: number;
  /** K en kcal/(h·m²·°C). */
  kKcalHm2C: number;
  /** Equivalente SI solo referencia. */
  uWm2K: number;
  productLabel: string;
  insulationLabel: string;
  doorLabel: string;
  kcalH: number;
  btuH: number;
  kw: number;
  hpNom: number;
  hpRangeLabel: string;
  tr: number;
  breakdown: ChamberLoadBreakdown;
  steps: ChamberLoadStep[];
  compressor: ChamberCompressorHint;
  correctionsNote: string;
  /** @deprecated compat UI */
  usageLabel: string;
  kcalPerM3: number;
  kcalPerM3Range: string;
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('es-AR');
}

function envelopeAreaM2(l: number, w: number, h: number): number {
  return 2 * (l * w + l * h + w * h);
}

function wallsLoadKcalH(areaM2: number, kKcalHm2C: number, deltaT: number): number {
  if (deltaT <= 0 || kKcalHm2C <= 0) return 0;
  return kKcalHm2C * areaM2 * deltaT;
}

function kToUWm2K(kKcalHm2C: number): number {
  return kKcalHm2C / W_TO_KCAL_H;
}

/** Carga diaria de producto (kcal) → kcal/h según horas de operación. */
function productLoadKcalH(input: {
  kgPerDay: number;
  tempInC: number;
  tempInteriorC: number;
  productType: ChamberProductType;
  opHours: number;
}): number {
  const { kgPerDay, tempInC, tempInteriorC, productType, opHours } = input;
  if (kgPerDay <= 0 || opHours <= 0 || productType === 'ninguno') return 0;

  const cp = CHAMBER_PRODUCT_TYPES.find((p) => p.id === productType)?.cpKcal ?? 0.85;
  let dailyKcal = 0;

  if (tempInteriorC >= 0) {
    const delta = Math.max(0, tempInC - tempInteriorC);
    dailyKcal = kgPerDay * cp * delta;
  } else {
    if (tempInC > 0) {
      dailyKcal += kgPerDay * cp * tempInC;
    }
    const latentKcalPerKg = productType === 'congelado' ? 55 : 45;
    if (tempInC > tempInteriorC) {
      dailyKcal += kgPerDay * latentKcalPerKg;
    }
    dailyKcal += kgPerDay * cp * Math.abs(tempInteriorC);
  }

  return dailyKcal / opHours;
}

function quickRuleKcalPerM3(interiorTempC: number, productType: ChamberProductType): number {
  if (interiorTempC <= -10 || productType === 'congelado') {
    return CHAMBER_USAGE_PRESETS.find((p) => p.id === 'baja_congelados')!.kcalPerM3Default;
  }
  if (productType === 'carne' || productType === 'lacteos' || interiorTempC <= 4) {
    return CHAMBER_USAGE_PRESETS.find((p) => p.id === 'media_generica')!.kcalPerM3Default;
  }
  return CHAMBER_USAGE_PRESETS.find((p) => p.id === 'media_verduras')!.kcalPerM3Default;
}

function suggestCompressor(hpLoad: number): ChamberCompressorHint {
  const sorted = [...MTZ_COMPRESSOR_REF].sort((a, b) => a.hp - b.hp);
  const recommended = sorted.find((c) => c.hp >= hpLoad) ?? sorted[sorted.length - 1];
  const below = sorted.filter((c) => c.hp < hpLoad);
  const stressedModel = below.length ? below[below.length - 1] : null;

  let note: string;
  if (recommended.hp >= hpLoad * 1.05) {
    note = `${recommended.model} (~${recommended.hp} HP) cubre la carga con margen razonable.`;
  } else if (recommended.hp >= hpLoad) {
    note = `${recommended.model} (~${recommended.hp} HP) es el tamaño mínimo habitual.`;
  } else {
    note = `La carga supera la referencia MTZ listada; consultá catálogo para compresor mayor.`;
  }

  return {
    stressed: stressedModel ? `${stressedModel.model} (~${stressedModel.hp} HP)` : null,
    recommended: `${recommended.model} (~${recommended.hp} HP)`,
    note,
  };
}

export type ChamberCalcMode = 'completo' | 'rapido';

export function estimateChamberLoad(input: {
  lengthM: number;
  widthM: number;
  heightM: number;
  exteriorTempC: number;
  interiorTempC: number;
  productType: ChamberProductType;
  insulation: ChamberInsulationPreset;
  customKKcalHm2C?: number;
  doorUsage: ChamberDoorUsage;
  kgProductPerDay: number;
  productInTempC: number;
  opHoursPerDay: number;
  motorsW: number;
  lightsW: number;
  peopleHeatW: number;
  safetyMarginPct: number;
  mode?: ChamberCalcMode;
  /** Solo modo rápido. */
  kcalPerM3Custom?: number;
}): ChamberLoadResult | null {
  const { lengthM: L, widthM: A, heightM: H } = input;
  if (!Number.isFinite(L) || !Number.isFinite(A) || !Number.isFinite(H) || L <= 0 || A <= 0 || H <= 0) {
    return null;
  }
  if (!Number.isFinite(input.exteriorTempC) || !Number.isFinite(input.interiorTempC)) return null;

  const volumeM3 = L * A * H;
  const surfaceM2 = envelopeAreaM2(L, A, H);
  const deltaTC = input.exteriorTempC - input.interiorTempC;

  const insPreset =
    CHAMBER_INSULATION_PRESETS.find((p) => p.id === input.insulation) ?? CHAMBER_INSULATION_PRESETS[2];
  let kKcalHm2C = insPreset.kKcalHm2C;
  if (input.insulation === 'custom_u') {
    const custom = input.customKKcalHm2C;
    if (!Number.isFinite(custom) || custom! <= 0) return null;
    kKcalHm2C = custom!;
  }
  const uWm2K = kToUWm2K(kKcalHm2C);

  const doorDef = CHAMBER_DOOR_USAGE.find((d) => d.id === input.doorUsage) ?? CHAMBER_DOOR_USAGE[1];
  const productDef = CHAMBER_PRODUCT_TYPES.find((p) => p.id === input.productType) ?? CHAMBER_PRODUCT_TYPES[0];
  const marginPct = Number.isFinite(input.safetyMarginPct) ? Math.max(0, input.safetyMarginPct) : 20;
  const opH = Number.isFinite(input.opHoursPerDay) && input.opHoursPerDay > 0 ? input.opHoursPerDay : 18;

  const mode = input.mode ?? 'completo';
  let breakdown: ChamberLoadBreakdown;

  if (mode === 'rapido') {
    let kcalPerM3 = quickRuleKcalPerM3(input.interiorTempC, input.productType);
    if (input.kcalPerM3Custom != null && Number.isFinite(input.kcalPerM3Custom) && input.kcalPerM3Custom > 0) {
      kcalPerM3 = input.kcalPerM3Custom;
    }
    const total = volumeM3 * kcalPerM3;
    breakdown = {
      wallsKcalH: 0,
      productKcalH: 0,
      infiltrationKcalH: 0,
      internalKcalH: 0,
      subtotalKcalH: total,
      safetyMarginKcalH: 0,
      totalKcalH: total,
      quickRuleKcalH: total,
    };
  } else {
    const walls = wallsLoadKcalH(surfaceM2, kKcalHm2C, deltaTC);
    const product = productLoadKcalH({
      kgPerDay: Math.max(0, input.kgProductPerDay),
      tempInC: input.productInTempC,
      tempInteriorC: input.interiorTempC,
      productType: input.productType,
      opHours: opH,
    });
    const infiltration = (walls + product) * doorDef.pct;
    const internal =
      (Math.max(0, input.motorsW) + Math.max(0, input.lightsW) + Math.max(0, input.peopleHeatW)) * W_TO_KCAL_H;
    const subtotal = walls + product + infiltration + internal;
    const safetyMargin = subtotal * (marginPct / 100);
    const total = subtotal + safetyMargin;
    const quickKcalPerM3 = quickRuleKcalPerM3(input.interiorTempC, input.productType);

    breakdown = {
      wallsKcalH: walls,
      productKcalH: product,
      infiltrationKcalH: infiltration,
      internalKcalH: internal,
      subtotalKcalH: subtotal,
      safetyMarginKcalH: safetyMargin,
      totalKcalH: total,
      quickRuleKcalH: volumeM3 * quickKcalPerM3,
    };
  }

  const kcalH = breakdown.totalKcalH;
  const btuH = kcalH * KCAL_TO_BTU;
  const kw = kcalH * KCAL_TO_KW;
  const hpNom = btuH / BTU_PER_HP_NOM;
  const tr = kw / 3.517;
  const hpCommercialLow = Math.floor(hpNom * 2) / 2;
  const hpRangeLabel = `${fmt(hpCommercialLow, 1)} – ${fmt(hpCommercialLow + 0.5, 1)} HP`;

  const kcalPerM3Ref = volumeM3 > 0 ? kcalH / volumeM3 : 0;
  const quickPreset = quickRuleKcalPerM3(input.interiorTempC, input.productType);
  const rangePreset =
    input.interiorTempC <= -10
      ? CHAMBER_USAGE_PRESETS[2]
      : input.productType === 'carne' || input.productType === 'lacteos'
        ? CHAMBER_USAGE_PRESETS[1]
        : CHAMBER_USAGE_PRESETS[0];

  const steps: ChamberLoadStep[] =
    mode === 'rapido'
      ? [
          { label: 'Volumen', detail: `${fmt(L, 1)} × ${fmt(A, 1)} × ${fmt(H, 1)} = ${fmt(volumeM3, 1)} m³` },
          {
            label: 'Regla rápida',
            detail: `${fmt(volumeM3, 1)} m³ × ${fmt(kcalPerM3Ref, 0)} kcal/h·m³ ≈ ${fmtInt(kcalH)} kcal/h`,
          },
          { label: 'kW', detail: `${fmtInt(kcalH)} ÷ 860 = ${fmt(kw, 2)} kW` },
        ]
      : [
          {
            label: 'Superficie envolvente',
            detail: `${fmt(surfaceM2, 1)} m² (paredes + techo + piso)`,
          },
          {
            label: 'Paredes / techo / piso',
            detail: `Q = K × A × ΔT → K ${fmt(kKcalHm2C, 2)} kcal/h·m²·°C × ${fmt(surfaceM2, 1)} m² × ${fmt(deltaTC, 0)} °C = ${fmtInt(breakdown.wallsKcalH)} kcal/h`,
          },
          {
            label: 'Producto',
            detail:
              input.kgProductPerDay > 0
                ? `${fmtInt(input.kgProductPerDay)} kg/día · ${fmt(input.productInTempC, 0)} °C → ${fmt(input.interiorTempC, 0)} °C · ${fmt(opH, 0)} h operación = ${fmtInt(breakdown.productKcalH)} kcal/h`
                : 'Sin carga de producto',
          },
          {
            label: 'Infiltración (puerta)',
            detail: `${Math.round(doorDef.pct * 100)} % sobre (paredes + producto) = ${fmtInt(breakdown.infiltrationKcalH)} kcal/h`,
          },
          {
            label: 'Motores / luces / personas',
            detail: `${fmtInt(breakdown.internalKcalH)} kcal/h (W × 0,86)`,
          },
          {
            label: 'Subtotal',
            detail: `${fmtInt(breakdown.subtotalKcalH)} kcal/h`,
          },
          {
            label: `Margen de seguridad (${fmt(marginPct, 0)} %)`,
            detail: `${fmtInt(breakdown.safetyMarginKcalH)} kcal/h`,
          },
          {
            label: 'Total',
            detail: `${fmtInt(kcalH)} kcal/h ≈ ${fmt(kw, 2)} kW ≈ ${fmtInt(btuH)} BTU/h`,
          },
        ];

  if (mode === 'completo' && breakdown.quickRuleKcalH != null) {
    steps.push({
      label: 'Referencia regla rápida m³',
      detail: `${fmt(volumeM3, 1)} m³ × ${quickPreset} kcal/h·m³ ≈ ${fmtInt(breakdown.quickRuleKcalH)} kcal/h (solo comparar)`,
    });
  }

  return {
    lengthM: L,
    widthM: A,
    heightM: H,
    volumeM3,
    surfaceM2,
    exteriorTempC: input.exteriorTempC,
    interiorTempC: input.interiorTempC,
    deltaTC,
    kKcalHm2C,
    uWm2K,
    productLabel: productDef.label,
    insulationLabel: insPreset.label,
    doorLabel: doorDef.label,
    kcalH,
    btuH,
    kw,
    hpNom,
    hpRangeLabel,
    tr,
    breakdown,
    steps,
    compressor: suggestCompressor(hpNom),
    correctionsNote:
      'Orientativo de taller. No incluye pull-down inicial de cámara vacía, antecámara, cortina PVC ni ubicación extrema. Validá con Coolselector o proyecto.',
    usageLabel: productDef.label,
    kcalPerM3: kcalPerM3Ref,
    kcalPerM3Range: `${rangePreset.kcalPerM3Min}–${rangePreset.kcalPerM3Max}`,
  };
}

/** Te evaporación orientativa para dimensionado TXV. */
export function chamberEvapTempC(interiorTempC: number, productType?: ChamberProductType): number {
  if (productType === 'congelado' || interiorTempC <= -10) {
    return Math.min(interiorTempC - 7, -25);
  }
  return interiorTempC - 10;
}

/** Compat: preset antiguo → tipo de producto. */
export function productTypeFromUsage(usage: ChamberUsagePreset): ChamberProductType {
  if (usage === 'baja_congelados') return 'congelado';
  if (usage === 'media_generica') return 'carne';
  return 'verdura';
}
