export type ChartTrendKind = 'up' | 'down' | 'flat';

export type ChartTrendSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  trend: ChartTrendKind;
};

/** Segmentos coloreados para preset «tendencia» (subida / bajada / plano). */
export function buildChartTrendSegments(
  pts: Array<{ x: number; y: number | null | undefined }>,
  epsilon = 0.001
): ChartTrendSegment[] {
  const out: ChartTrendSegment[] = [];
  if (pts.length < 2) return out;
  for (let i = 0; i < pts.length - 1; i++) {
    const y0 = pts[i].y;
    const y1 = pts[i + 1].y;
    if (y0 == null || y1 == null || !Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    const d = y1 - y0;
    const trend: ChartTrendKind = d > epsilon ? 'up' : d < -epsilon ? 'down' : 'flat';
    out.push({ x1: pts[i].x, y1: y0, x2: pts[i + 1].x, y2: y1, trend });
  }
  return out;
}
