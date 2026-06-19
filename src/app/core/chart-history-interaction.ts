import {
  chartZoomAdjust,
  chartZoomIsActive,
  chartZoomPan,
  chartZoomPinch,
  chartZoomReset,
  chartZoomSlice,
  chartZoomWheel,
  CHART_ZOOM_BUTTON_FACTOR,
  type ChartZoomRange,
} from './chart-zoom';

export type ChartZoomHost = {
  chartZoomLo: number;
  chartZoomHi: number;
  rebuildChartGeometry(): void;
};

export function chartZoomHostRange(h: ChartZoomHost): ChartZoomRange {
  return { lo: h.chartZoomLo, hi: h.chartZoomHi };
}

export function chartZoomHostApply(h: ChartZoomHost, z: ChartZoomRange): void {
  h.chartZoomLo = z.lo;
  h.chartZoomHi = z.hi;
  h.rebuildChartGeometry();
}

export function chartZoomHostIsActive(h: ChartZoomHost): boolean {
  return chartZoomIsActive(chartZoomHostRange(h));
}

export function chartZoomHostReset(h: ChartZoomHost): void {
  const z = chartZoomHostRange(h);
  chartZoomReset(z);
  chartZoomHostApply(h, z);
}

export function chartZoomHostIn(h: ChartZoomHost): void {
  const z = chartZoomHostRange(h);
  chartZoomAdjust(z, CHART_ZOOM_BUTTON_FACTOR);
  chartZoomHostApply(h, z);
}

export function chartZoomHostOut(h: ChartZoomHost): void {
  const z = chartZoomHostRange(h);
  chartZoomAdjust(z, 1 / CHART_ZOOM_BUTTON_FACTOR);
  chartZoomHostApply(h, z);
}

export function chartZoomHostSlice<T>(h: ChartZoomHost, src: T[]): T[] {
  return chartZoomSlice(src, chartZoomHostRange(h));
}

export function chartZoomHostWheel(
  h: ChartZoomHost,
  ev: WheelEvent,
  chartStage: HTMLElement | null | undefined,
  hasPoints: boolean
): void {
  if (!chartStage || !hasPoints) return;
  const r = chartStage.getBoundingClientRect();
  if (r.width <= 1) return;
  const xNorm = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  const z = chartZoomHostRange(h);
  if (chartZoomWheel(z, ev.deltaY, xNorm)) {
    chartZoomHostApply(h, z);
    ev.preventDefault();
  }
}

export function chartZoomHostPanFromDrag(
  h: ChartZoomHost,
  dxNorm: number,
  startLo: number,
  startHi: number
): void {
  const z: ChartZoomRange = { lo: startLo, hi: startHi };
  chartZoomPan(z, dxNorm);
  chartZoomHostApply(h, z);
}

export function chartZoomHostPinch(
  h: ChartZoomHost,
  scale: number,
  centerNorm: number
): void {
  const z = chartZoomHostRange(h);
  chartZoomPinch(z, scale, centerNorm);
  chartZoomHostApply(h, z);
}

export function chartStyleLabel(
  options: { value: string; label: string }[],
  preset: string
): string {
  return options.find((o) => o.value === preset)?.label ?? preset;
}
