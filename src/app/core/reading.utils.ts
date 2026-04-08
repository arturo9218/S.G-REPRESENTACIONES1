import { environment } from '../../environments/environment';
import { TemperatureReading } from './models/dashboard.models';

type CurrentFields = Pick<TemperatureReading, 'currentA' | 'powerW'>;

/**
 * Corriente RMS (A): prioriza `current_a`; si falta, estima `power_w / V`.
 * `nominalVoltageV` es la tensión del tablero (220, 380, etc.); si falta, usa
 * `environment.displayLineVoltageVForFallback`.
 */
export function effectiveCurrentAWithNominal(
  r: CurrentFields,
  nominalVoltageV: number | null | undefined
): number | null {
  const c = r.currentA;
  if (c != null && Number.isFinite(c)) return c;
  const v =
    nominalVoltageV != null && nominalVoltageV > 0
      ? nominalVoltageV
      : environment.displayLineVoltageVForFallback;
  if (v == null || v <= 0) return null;
  const p = r.powerW;
  if (p != null && Number.isFinite(p) && p > 0) return p / v;
  return null;
}

/**
 * Variante sin tensión por equipo (solo fallback de entorno).
 */
export function effectiveCurrentA(r: TemperatureReading): number | null {
  return effectiveCurrentAWithNominal(r, undefined);
}
