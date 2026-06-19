import {
  selectDanfossValve,
  DANFOSS_VALVE_LINES,
  type DanfossValveSelection,
  danfossSubcoolingFactor,
  danfossDistributorFactor,
  danfossCondensingFactor,
} from './danfoss-t2-te2.data';
import { absBarFromSatTemp, formatNum, fromAbsBar, type PtPoint } from './refrigerant-pt.utils';
import type { DanfossApplication } from './danfoss-valve-lines.data';
import { selectTe5TexLine, type DanfossTe5Selection } from './danfoss-te5.data';
import { selectTuaTuaeAlternative, type DanfossTuaSelection } from './danfoss-tua.data';

export interface TxvSizingInput {
  refrigerantId: string;
  capacityKw: number;
  evapTempC: number;
  condTempC: number;
  superheatK: number;
  subcoolingK: number;
  /** Equalización externa TE2 (distribuidor / varias vías). */
  externalEqualization: boolean;
  /** Caída de presión en distribuidor de líquido (bar); 0 si no hay. */
  distributorDropBar: number;
  application: DanfossApplication;
}

export interface TxvSizingBreakdown {
  capacityKw: number;
  requiredCapacityKw: number;
  fsub: number;
  fp: number;
  ftc: number;
  evapTempC: number;
  condTempC: number;
  subcoolingK: number;
  distributorDropBar: number;
}

export interface TxvSizingResult {
  capacityTr: number;
  massFlowKgH: number;
  suctionPressureBarG: number | null;
  orificeHint: string;
  nominalRangeKw: string;
  notes: string[];
  danfoss: DanfossValveSelection;
  valveSummary: string;
  orificeLabel: string;
  valveBodyLabel: string;
  valveLinesCatalog: typeof DANFOSS_VALVE_LINES;
  tuaAlternative: DanfossTuaSelection | null;
  te5Alternative: DanfossTe5Selection | null;
  breakdown: TxvSizingBreakdown;
}

/** Texto compacto para el campo Orificio / cartucho de la ficha. */
export function danfossOrificeFichaText(result: TxvSizingResult): string {
  const d = result.danfoss;
  if (d.valveLine === 't2_te2') {
    return `Danfoss ${d.valveBody} · orif. ${d.orifice} · ${d.orificeCode}`;
  }
  if (d.valveLine === 'tr6') {
    return `Danfoss TR6 · orif. ${d.orifice} · ${d.orificeCode}`;
  }
  return `Danfoss ${d.orifice} · ${d.orificeCode}`;
}

function valveBodyLabelFor(d: DanfossValveSelection): string {
  if (d.valveLine === 't2_te2') {
    return d.valveBody === 'TE2'
      ? 'TE2 (equalización externa — distribuidor o varias vías)'
      : 'T2 (equalización interna — circuito único sin distribuidor)';
  }
  if (d.valveLine === 'tr6') {
    return 'TR6 (A/C · equalización externa · orificio fijo 3–7)';
  }
  return `${d.valveBody} (línea TGE · válvula por tamaño, puerto balanceado)`;
}

function orificeLabelFor(d: DanfossValveSelection): string {
  if (d.valveLine === 't2_te2') {
    return `Orificio ${d.orifice} · cartucho ${d.orificeCode}`;
  }
  if (d.valveLine === 'tr6') {
    return `Orificio ${d.orifice} · ${d.orificeCode}`;
  }
  return `Modelo ${d.orifice}`;
}

/** Dimensionado orientativo por línea Danfoss. */
export function sizeTxv(input: TxvSizingInput, points: readonly PtPoint[]): TxvSizingResult | null {
  const q = input.capacityKw;
  const te = input.evapTempC;
  const tc = input.condTempC;
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(te) || !Number.isFinite(tc)) return null;
  if (tc <= te + 5) return null;

  const sh = Number.isFinite(input.superheatK) ? Math.max(0, input.superheatK) : 8;
  const sc = Number.isFinite(input.subcoolingK) ? Math.max(0, input.subcoolingK) : 3;
  const distributorDropBar =
    input.externalEqualization && Number.isFinite(input.distributorDropBar)
      ? Math.max(0, input.distributorDropBar)
      : 0;
  const fsub = danfossSubcoolingFactor(sc);
  const fp = danfossDistributorFactor(distributorDropBar);
  const ftc = danfossCondensingFactor(tc);
  const deltaT = tc - te;
  const enthalpyKjKg = 145 + deltaT * 2.2 + sh * 0.4 - sc * 0.15;
  const safeDh = Math.max(120, Math.min(260, enthalpyKjKg));
  const massFlowKgS = q / safeDh;
  const massFlowKgH = massFlowKgS * 3600;
  const capacityTr = q / 3.517;

  const danfoss = selectDanfossValve({
    refrigerantId: input.refrigerantId,
    capacityKw: q,
    evapTempC: te,
    condTempC: tc,
    subcoolingK: sc,
    distributorDropBar: input.distributorDropBar,
    externalEqualization: input.externalEqualization,
    application: input.application,
  });
  if (!danfoss) return null;

  const pAbs = absBarFromSatTemp(points, te);
  const suctionPressureBarG = pAbs != null ? fromAbsBar(pAbs, 'bar_g') : null;

  const lo = q * 0.85;
  const hi = q * 1.15;
  const valveBodyLabel = valveBodyLabelFor(danfoss);
  const orificeLabel = orificeLabelFor(danfoss);
  const valveSummary = `${danfoss.valveLineLabel} · ${danfoss.valveBody} · ${danfoss.elementRange.label} · ${orificeLabel}`;

  const lineInfo = DANFOSS_VALVE_LINES.find((l) => l.id === danfoss.valveLine);
  const notes: string[] = [
    `Línea elegida: ${danfoss.valveLineLabel} — ${danfoss.lineReason}`,
    lineInfo ? `${lineInfo.orifices}. Conexión: ${lineInfo.connection}.` : '',
    `Condiciones: Te ${formatNum(te, 1)} °C · Tc ${formatNum(tc, 1)} °C · recal. ${formatNum(sh, 0)} K · subenf. ${formatNum(sc, 0)} K.`,
    `Carga ${formatNum(q, 2)} kW → selección ${formatNum(danfoss.requiredCapacityKw, 2)} kW (fsub, fp, Tc).`,
    `Sugerencia: ${orificeLabel} (~${formatNum(danfoss.ratedCapacityKw, 2)} kW a Te ${formatNum(te, 0)} °C).`,
    `Caudal másico ~${formatNum(massFlowKgH, 0)} kg/h (Δh ≈ ${formatNum(safeDh, 0)} kJ/kg).`,
    danfoss.elementRange.mopNote,
  ].filter(Boolean);

  if (danfoss.nextOrifice && danfoss.nextRatedCapacityKw != null) {
    notes.push(
      `Margen ajustado en T2/TE2: orificio ${danfoss.nextOrifice} (~${formatNum(danfoss.nextRatedCapacityKw, 2)} kW).`
    );
  }
  for (const alt of danfoss.alternatives) {
    if (alt.includes('soldada ODF') || alt.includes('TUA/TUAE')) continue;
    notes.push(alt);
  }
  if (danfoss.estimatedRefrigerant) {
    notes.push('Refrigerante sin tabla Danfoss dedicada: estimación desde R404A. Validar con Coolselector®2.');
  }
  if (suctionPressureBarG != null) {
    notes.push(`Presión de succión esperada ~${formatNum(suctionPressureBarG, 2)} bar g (tabla P–T).`);
  }

  const tuaAlternative =
    danfoss.valveLine === 't2_te2'
      ? selectTuaTuaeAlternative({
          refrigerantId: input.refrigerantId,
          evapTempC: te,
          requiredKw: danfoss.requiredCapacityKw,
          externalEqualization: input.externalEqualization,
        })
      : null;

  if (tuaAlternative) {
    notes.push(
      `Alternativa soldadura TUA/TUAE: ${tuaAlternative.summary} — mismo criterio de carga, conexión ODF en lugar de flare.`
    );
  }

  const te5Alternative = selectTe5TexLine({
    refrigerantId: input.refrigerantId,
    capacityKw: q,
    evapTempC: te,
    condTempC: tc,
    subcoolingK: sc,
    distributorDropBar: input.distributorDropBar,
  });

  if (te5Alternative) {
    notes.push(
      `Línea TE5 / TEX (rango N): ${te5Alternative.summary} — cuerpo según carga (TE5 → TE12 → TE20 → TE55).`
    );
    if (te5Alternative.estimatedRefrigerant) {
      notes.push('Capacidad TE5 estimada desde R404A; validar refrigerante en Coolselector®2.');
    }
  }

  let orificeHint: string;
  if (danfoss.valveLine === 't2_te2') {
    orificeHint = `${danfoss.valveBody} orif. ${danfoss.orifice} (${danfoss.orificeCode})`;
  } else if (danfoss.valveLine === 'tr6') {
    orificeHint = `TR6 orif. ${danfoss.orifice}`;
  } else {
    orificeHint = danfoss.orifice;
  }

  return {
    capacityTr,
    massFlowKgH,
    suctionPressureBarG,
    orificeHint,
    nominalRangeKw: `${formatNum(lo, 1)}–${formatNum(hi, 1)} kW (${formatNum(lo / 3.517, 2)}–${formatNum(hi / 3.517, 2)} TR) a Te ${formatNum(te, 0)} °C`,
    notes,
    danfoss,
    valveSummary,
    orificeLabel,
    valveBodyLabel,
    valveLinesCatalog: DANFOSS_VALVE_LINES,
    tuaAlternative,
    te5Alternative,
    breakdown: {
      capacityKw: q,
      requiredCapacityKw: danfoss.requiredCapacityKw,
      fsub,
      fp,
      ftc,
      evapTempC: te,
      condTempC: tc,
      subcoolingK: sc,
      distributorDropBar,
    },
  };
}
