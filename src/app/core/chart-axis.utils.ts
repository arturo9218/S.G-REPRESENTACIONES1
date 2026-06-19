export interface ChartPlotBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ChartYAxisTick {
  y: number;
  label: string;
  markX0: number;
  markX1: number;
}

export interface ChartTimeLabel {
  x: number;
  y: number;
  text: string;
  tickY0: number;
  tickY1: number;
}

const MS = 1000;
const DAY = 24 * 3600 * MS;

const TIME_STEP_CANDIDATES_MS = [
  10 * MS,
  15 * MS,
  30 * MS,
  60 * MS,
  2 * 60 * MS,
  5 * 60 * MS,
  10 * 60 * MS,
  15 * 60 * MS,
  30 * 60 * MS,
  3600 * MS,
  2 * 3600 * MS,
  3 * 3600 * MS,
  4 * 3600 * MS,
  6 * 3600 * MS,
  12 * 3600 * MS,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
  180 * DAY,
  365 * DAY,
];

export function chartNiceStep(range: number, targetTicks: number): number {
  const rough = range / Math.max(targetTicks - 1, 1);
  const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-9))));
  const err = rough / pow10;
  let n = 10;
  if (err <= 1) n = 1;
  else if (err <= 2) n = 2;
  else if (err <= 5) n = 5;
  return n * pow10;
}

export function chartPickTimeStepMs(spanMs: number, maxTicks: number): number {
  const minStep = spanMs / Math.max(maxTicks, 2);
  for (const s of TIME_STEP_CANDIDATES_MS) {
    if (s >= minStep * 0.98) return s;
  }
  return Math.ceil(minStep / DAY) * DAY;
}

export function chartFormatTimeAxisLabel(tMs: number, spanMs: number): string {
  const d = new Date(tMs);
  if (spanMs <= 10 * 60 * MS) {
    return d.toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  if (spanMs <= 6 * 3600 * MS) {
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  if (spanMs <= 72 * 3600 * MS) {
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  if (spanMs <= 21 * DAY) {
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function chartMergeTimeEndpoints(epochs: number[], t0: number, t1: number, spanMs: number): number[] {
  const merged = [...epochs];
  const gap = Math.max(spanMs * 0.025, 45_000);
  merged.sort((a, b) => a - b);
  if (merged.length === 0) return [t0, t1];
  if (merged[0] - t0 > gap) merged.unshift(t0);
  if (t1 - merged[merged.length - 1] > gap) merged.push(t1);
  return [...new Set(merged)].sort((a, b) => a - b);
}

export function buildTempYAxisTicks(
  plot: ChartPlotBounds,
  vMin: number,
  vMax: number,
  yAt: (v: number) => number
): { ticks: ChartYAxisTick[]; gridLines: string[] } {
  const { x0, x1, y0, y1 } = plot;
  const span = vMax - vMin || 1;
  const step = chartNiceStep(span, 6);
  const firstTick = Math.ceil(vMin / step) * step;
  const ticks: ChartYAxisTick[] = [];
  const grids: string[] = [];
  const markX0 = x0 - 1.35;
  const markX1 = x0;

  for (let v = firstTick; v <= vMax + step * 0.001; v += step) {
    if (v < vMin - step * 0.001) continue;
    const yp = yAt(v);
    if (yp < y0 - 0.5 || yp > y1 + 0.5) continue;
    ticks.push({
      y: yp,
      label: `${v.toFixed(vMax - vMin < 2 ? 1 : 0)}°`,
      markX0,
      markX1,
    });
    grids.push(`M${x0.toFixed(2)},${yp.toFixed(2)}L${x1.toFixed(2)},${yp.toFixed(2)}`);
    if (ticks.length >= 9) break;
  }

  if (ticks.length === 0) {
    ticks.push({ y: yAt(vMax), label: `${vMax.toFixed(1)}°`, markX0, markX1 });
    ticks.push({ y: yAt(vMin), label: `${vMin.toFixed(1)}°`, markX0, markX1 });
    grids.push(`M${x0.toFixed(2)},${yAt(vMax).toFixed(2)}L${x1.toFixed(2)},${yAt(vMax).toFixed(2)}`);
    grids.push(`M${x0.toFixed(2)},${yAt(vMin).toFixed(2)}L${x1.toFixed(2)},${yAt(vMin).toFixed(2)}`);
  }

  return { ticks, gridLines: grids };
}

export function buildChartTimeAxis(
  plot: ChartPlotBounds,
  t0: number,
  t1: number,
  span: number,
  xAt: (iso: string) => number
): { timeLabels: ChartTimeLabel[]; xGridLines: string[] } {
  const { x0, x1, y0, y1 } = plot;
  const plotW = x1 - x0;
  const stepMs = chartPickTimeStepMs(span, 6);
  let curT = Math.floor(t0 / stepMs) * stepMs;
  while (curT < t0 - 0.5) curT += stepMs;
  const epochList: number[] = [];
  while (curT <= t1 + stepMs * 0.01) {
    if (curT >= t0 && curT <= t1) epochList.push(curT);
    curT += stepMs;
    if (epochList.length > 18) break;
  }
  const mergedEpochs = chartMergeTimeEndpoints(epochList, t0, t1, span);
  const timeLabels: ChartTimeLabel[] = [];
  const xGridLines: string[] = [];
  let prevX = -Infinity;
  const minLabelDx = Math.max(11, plotW / 6.5);

  for (const tm of mergedEpochs) {
    const x = xAt(new Date(tm).toISOString());
    if (x < x0 - 0.02 || x > x1 + 0.02) continue;
    if (x - prevX < minLabelDx) continue;
    prevX = x;
    timeLabels.push({
      x,
      y: y1 + 5.8,
      text: chartFormatTimeAxisLabel(tm, span),
      tickY0: y1,
      tickY1: y1 + 2.6,
    });
    if (timeLabels.length <= 12) {
      xGridLines.push(`M${x.toFixed(2)},${y0.toFixed(2)}L${x.toFixed(2)},${y1.toFixed(2)}`);
    }
  }

  return { timeLabels, xGridLines };
}
