import { environment } from '../../environments/environment';
import { TemperatureReading } from './models/dashboard.models';

/**
 * Corriente RMS (A): prioriza `current_a` de la lectura; si falta, estima desde `power_w`
 * y la tensión de línea de respaldo (misma idea que el firmware del ESP).
 */
export function effectiveCurrentA(r: TemperatureReading): number | null {
  const c = r.currentA;
  if (c != null && Number.isFinite(c)) return c;
  const v = environment.displayLineVoltageVForFallback;
  if (v == null || v <= 0) return null;
  const p = r.powerW;
  if (p != null && Number.isFinite(p) && p > 0) return p / v;
  return null;
}
