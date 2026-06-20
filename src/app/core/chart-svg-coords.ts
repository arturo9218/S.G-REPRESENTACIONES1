import type { ChartPlotBounds } from './chart-axis.utils';

/** ViewBox panorámico para series temporales (ancho completo sin bandas laterales). */
export const CHART_TEMP_VIEWBOX_HEIGHT = 58;

/** Área de trazado en viewBox 0 0 100 × CHART_TEMP_VIEWBOX_HEIGHT (márgenes mínimos). */
export const CHART_TEMP_PLOT: ChartPlotBounds = { x0: 4, x1: 99.8, y0: 3.8, y1: 48 };

/** PR500: más margen izquierdo para etiquetas de presión con unidad. */
export const CHART_PR500_PLOT: ChartPlotBounds = { x0: 12, x1: 99, y0: 3.8, y1: 48 };

export const CHART_SVG_PRESERVE_ASPECT = 'xMidYMid meet';
export function chartClientXToViewBoxX(svg: SVGSVGElement, clientX: number): number | null {
  try {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    const r = svg.getBoundingClientRect();
    pt.y = r.top + r.height * 0.5;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse()).x;
  } catch {
    return null;
  }
}

export function chartMainSvg(stage: HTMLElement | null | undefined): SVGSVGElement | null {
  return (stage?.querySelector('svg.pr5-svg') as SVGSVGElement | null) ?? null;
}

/** Fracción 0–1 sobre el eje X del área de trazado. */
export function chartPlotNormFromClientX(
  clientX: number,
  plotX0: number,
  plotX1: number,
  stage: HTMLElement | null | undefined,
  svg?: SVGSVGElement | null
): number | null {
  const el = svg ?? chartMainSvg(stage);
  if (el) {
    const vx = chartClientXToViewBoxX(el, clientX);
    if (vx != null && Number.isFinite(vx)) {
      return Math.max(0, Math.min(1, (vx - plotX0) / Math.max(0.0001, plotX1 - plotX0)));
    }
  }
  if (!stage) return null;
  const r = stage.getBoundingClientRect();
  if (r.width <= 1) return null;
  const x = ((clientX - r.left) / r.width) * 100;
  return Math.max(0, Math.min(1, (x - plotX0) / Math.max(0.0001, plotX1 - plotX0)));
}

/** Posición X en viewBox 0–100 para cursor vertical. */
export function chartViewBoxXFromClientX(
  clientX: number,
  stage: HTMLElement | null | undefined,
  svg?: SVGSVGElement | null
): number | null {
  const el = svg ?? chartMainSvg(stage);
  if (el) {
    const vx = chartClientXToViewBoxX(el, clientX);
    if (vx != null && Number.isFinite(vx)) return vx;
  }
  if (!stage) return null;
  const r = stage.getBoundingClientRect();
  if (r.width <= 1) return null;
  return ((clientX - r.left) / r.width) * 100;
}
