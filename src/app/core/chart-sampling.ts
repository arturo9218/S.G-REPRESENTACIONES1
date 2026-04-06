import type { TemperatureReading } from './models/dashboard.models';

/** Máximo de puntos enviados al canvas del gráfico (rendimiento en móvil). */
export const CHART_DISPLAY_MAX_POINTS = 8000;

/**
 * Reduce puntos conservando inicio y fin del rango temporal (evita “cortar” solo el final).
 */
export function capChartPointsSorted(
  sorted: TemperatureReading[],
  cap = CHART_DISPLAY_MAX_POINTS
): TemperatureReading[] {
  if (sorted.length <= cap) return sorted;
  const out: TemperatureReading[] = [];
  const lastIndex = sorted.length - 1;
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * lastIndex) / (cap - 1));
    out.push(sorted[idx]);
  }
  return out;
}
