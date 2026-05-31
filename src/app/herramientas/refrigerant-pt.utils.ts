/** Presión atmosférica estándar (bar absolutos) para pasar manométrica ↔ absoluta. */
export const ATM_BAR = 1.01325;
export const PSI_PER_BAR = 14.5038;

export type PressureUnit = 'bar_g' | 'bar_a' | 'psi_g' | 'psi_a';

export interface PtPoint {
  t: number;
  /** Presión absoluta (bar). */
  p: number;
}

/** Interpolación lineal T ↔ P absoluta (bar). */
export function satTempFromAbsBar(points: readonly PtPoint[], pAbsBar: number): number | null {
  if (!points.length || !Number.isFinite(pAbsBar) || pAbsBar <= 0) return null;
  const sorted = [...points].sort((a, b) => a.p - b.p);
  if (pAbsBar <= sorted[0].p) return sorted[0].t;
  if (pAbsBar >= sorted[sorted.length - 1].p) return sorted[sorted.length - 1].t;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pAbsBar >= a.p && pAbsBar <= b.p) {
      const k = (pAbsBar - a.p) / (b.p - a.p);
      return a.t + k * (b.t - a.t);
    }
  }
  return sorted[sorted.length - 1].t;
}

export function absBarFromSatTemp(points: readonly PtPoint[], tempC: number): number | null {
  if (!points.length || !Number.isFinite(tempC)) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (tempC <= sorted[0].t) return sorted[0].p;
  if (tempC >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].p;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (tempC >= a.t && tempC <= b.t) {
      const k = (tempC - a.t) / (b.t - a.t);
      return a.p + k * (b.p - a.p);
    }
  }
  return sorted[sorted.length - 1].p;
}

export function toAbsBar(value: number, unit: PressureUnit): number | null {
  if (!Number.isFinite(value)) return null;
  switch (unit) {
    case 'bar_a':
      return value;
    case 'bar_g':
      return value + ATM_BAR;
    case 'psi_a':
      return value / PSI_PER_BAR;
    case 'psi_g':
      return value / PSI_PER_BAR + ATM_BAR;
    default:
      return null;
  }
}

export function fromAbsBar(pAbsBar: number, unit: PressureUnit): number | null {
  if (!Number.isFinite(pAbsBar)) return null;
  switch (unit) {
    case 'bar_a':
      return pAbsBar;
    case 'bar_g':
      return pAbsBar - ATM_BAR;
    case 'psi_a':
      return pAbsBar * PSI_PER_BAR;
    case 'psi_g':
      return (pAbsBar - ATM_BAR) * PSI_PER_BAR;
    default:
      return null;
  }
}

export function formatNum(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export interface SuperheatResult {
  satTempC: number;
  superheatC: number;
  targetC: number;
  deltaC: number;
  hint: string;
  severity: 'ok' | 'low' | 'high';
}

/** Calculadora de superheat y orientación de ajuste TXV (referencia de campo, no sustituye manual del fabricante). */
export function evaluateSuperheat(
  suctionTempC: number,
  pAbsBar: number,
  points: readonly PtPoint[],
  targetSuperheatC: number
): SuperheatResult | null {
  const sat = satTempFromAbsBar(points, pAbsBar);
  if (sat == null || !Number.isFinite(suctionTempC)) return null;
  const sh = suctionTempC - sat;
  const target = Number.isFinite(targetSuperheatC) ? targetSuperheatC : 8;
  const delta = sh - target;
  let severity: SuperheatResult['severity'] = 'ok';
  let hint =
    'Recalentamiento dentro del rango objetivo. Verificá carga, caída de línea y condiciones de evaporación antes de tocar la válvula.';

  if (delta < -2) {
    severity = 'low';
    hint =
      'Recalentamiento bajo: posible líquido en succión (válvula muy abierta o carga alta). Cerrá la válvula de expansión en pasos pequeños (≈ ¼ vuelta), esperá estabilización y volvé a medir.';
  } else if (delta > 2) {
    severity = 'high';
    hint =
      'Recalentamiento alto: posible falta de refrigerante en evaporador (válvula muy cerrada o carga baja). Abrí la válvula en pasos pequeños (≈ ¼ vuelta), controlá presión y temperatura de succión.';
  } else if (delta < -0.5) {
    severity = 'low';
    hint = 'Ligeramente por debajo del objetivo: considerá cerrar un poco la válvula y confirmar con una segunda medición.';
  } else if (delta > 0.5) {
    severity = 'high';
    hint = 'Ligeramente por encima del objetivo: considerá abrir un poco la válvula; revisá también filtro/seca y subenfriamiento en líquido.';
  }

  return { satTempC: sat, superheatC: sh, targetC: target, deltaC: delta, hint, severity };
}

export interface SubcoolingResult {
  satTempC: number;
  subcoolingC: number;
  targetC: number;
  deltaC: number;
  hint: string;
  severity: 'ok' | 'low' | 'high' | 'negative';
}

/** Subenfriamiento en línea de líquido: T_sat(p) − T_líquido medida. */
export function evaluateSubcooling(
  liquidTempC: number,
  pAbsBar: number,
  points: readonly PtPoint[],
  targetSubcoolingC: number
): SubcoolingResult | null {
  const sat = satTempFromAbsBar(points, pAbsBar);
  if (sat == null || !Number.isFinite(liquidTempC)) return null;
  const sc = sat - liquidTempC;
  const target = Number.isFinite(targetSubcoolingC) ? targetSubcoolingC : 3;
  const delta = sc - target;

  if (sc < 0) {
    return {
      satTempC: sat,
      subcoolingC: sc,
      targetC: target,
      deltaC: delta,
      severity: 'negative',
      hint:
        'Subenfriamiento negativo: el líquido está más caliente que la saturación a esa presión (flash gas, punto de medición incorrecto o condiciones inestables). Revisá filtro/seca, carga y ubicación del sensor.',
    };
  }

  let severity: SubcoolingResult['severity'] = 'ok';
  let hint =
    'Subenfriamiento dentro del rango objetivo. Indica líquido subenfriado antes de la válvula; verificá también recalentamiento en succión.';

  if (delta < -2) {
    severity = 'low';
    hint =
      'Subenfriamiento bajo: posible flash gas en línea de líquido, condensación insuficiente o carga baja. Revisá condensador, filtro/seca, caída de línea y carga antes de ajustar la válvula.';
  } else if (delta > 2) {
    severity = 'high';
    hint =
      'Subenfriamiento alto: posible sobrecarga, condensador muy eficiente o restricción aguas arriba del punto de medición. Confirmá carga y temperatura ambiente.';
  } else if (delta < -0.5) {
    severity = 'low';
    hint = 'Ligeramente por debajo del objetivo: controlá condensación y filtro/seca; puede afectar el dimensionado de la válvula.';
  } else if (delta > 0.5) {
    severity = 'high';
    hint = 'Ligeramente por encima del objetivo: habitual con buen subenfriamiento en condensador; verificá que no haya sobrecarga.';
  }

  return { satTempC: sat, subcoolingC: sc, targetC: target, deltaC: delta, hint, severity };
}
