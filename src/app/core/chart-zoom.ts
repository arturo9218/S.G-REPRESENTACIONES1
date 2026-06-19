export const CHART_ZOOM_MIN_SPAN = 0.06;
export const CHART_ZOOM_WHEEL_FACTOR = 0.82;
export const CHART_ZOOM_BUTTON_FACTOR = 0.72;

export type ChartZoomRange = { lo: number; hi: number };

export function chartZoomIsActive(z: ChartZoomRange): boolean {
  return z.lo > 0.0001 || z.hi < 0.9999;
}

export function chartZoomReset(z: ChartZoomRange): void {
  z.lo = 0;
  z.hi = 1;
}

function clampZoomRange(z: ChartZoomRange, lo: number, hi: number, minSpan: number): void {
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > 1) {
    lo -= hi - 1;
    hi = 1;
  }
  lo = Math.max(0, lo);
  hi = Math.min(1, hi);
  if (hi - lo < minSpan) {
    hi = Math.min(1, lo + minSpan);
    lo = Math.max(0, hi - minSpan);
  }
  z.lo = lo;
  z.hi = hi;
}

/** Zoom centrado en fracción 0…1 del ancho visible. */
export function chartZoomAdjust(
  z: ChartZoomRange,
  factor: number,
  centerNorm = 0.5,
  minSpan = CHART_ZOOM_MIN_SPAN
): void {
  const span = z.hi - z.lo;
  const center = z.lo + span * centerNorm;
  let next = span * factor;
  next = Math.max(minSpan, Math.min(1, next));
  const lo = center - next * centerNorm;
  const hi = lo + next;
  clampZoomRange(z, lo, hi, minSpan);
}

/** Rueda del mouse: deltaY &lt; 0 acerca. Devuelve true si cambió el rango. */
export function chartZoomWheel(
  z: ChartZoomRange,
  deltaY: number,
  pointerNorm: number,
  minSpan = CHART_ZOOM_MIN_SPAN
): boolean {
  const span = z.hi - z.lo;
  const center = z.lo + pointerNorm * span;
  const factor = deltaY < 0 ? CHART_ZOOM_WHEEL_FACTOR : 1 / CHART_ZOOM_WHEEL_FACTOR;
  let next = span * factor;
  next = Math.max(minSpan, Math.min(1, next));
  const lo = center - next * pointerNorm;
  const hi = lo + next;
  const prevLo = z.lo;
  const prevHi = z.hi;
  clampZoomRange(z, lo, hi, minSpan);
  return z.lo !== prevLo || z.hi !== prevHi;
}

/** Desplaza el ventana de zoom (dxNorm = fracción del ancho arrastrada). */
export function chartZoomPan(
  z: ChartZoomRange,
  dxNorm: number,
  minSpan = CHART_ZOOM_MIN_SPAN
): void {
  const span = z.hi - z.lo;
  const lo = z.lo - dxNorm * span;
  const hi = z.hi - dxNorm * span;
  clampZoomRange(z, lo, hi, minSpan);
}

/** Pinch: scale &gt; 1 aleja, &lt; 1 acerca. */
export function chartZoomPinch(
  z: ChartZoomRange,
  scale: number,
  centerNorm: number,
  minSpan = CHART_ZOOM_MIN_SPAN
): void {
  const span = z.hi - z.lo;
  let next = span * scale;
  next = Math.max(minSpan, Math.min(1, next));
  const lo = centerNorm - next * centerNorm;
  const hi = lo + next;
  clampZoomRange(z, lo, hi, minSpan);
}

export function chartZoomSlice<T>(src: T[], z: ChartZoomRange): T[] {
  if (!src.length || !chartZoomIsActive(z)) return src;
  const n = src.length;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(z.lo * (n - 1))));
  const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil(z.hi * (n - 1)) + 1));
  const out = src.slice(i0, i1);
  return out.length >= 2 ? out : src.slice(Math.max(0, i0 - 1), Math.min(n, i1 + 1));
}
