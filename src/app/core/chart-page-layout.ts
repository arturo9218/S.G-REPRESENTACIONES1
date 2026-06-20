export type ChartSectionHeights = {
  mainTall: boolean;
  histTall: boolean;
  activityTall: boolean;
};

export type ChartPagePanels = {
  sideOpen: boolean;
  extrasOpen: boolean;
  heights?: Partial<ChartSectionHeights>;
};

export function chartPagePanelsDefaults(): ChartPagePanels {
  return { sideOpen: false, extrasOpen: false };
}

export function chartSectionHeightsDefaults(): ChartSectionHeights {
  return { mainTall: false, histTall: false, activityTall: false };
}

export function loadChartPagePanels(storageKey: string): ChartPagePanels {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return chartPagePanelsDefaults();
    const o = JSON.parse(raw) as Partial<ChartPagePanels>;
    const d = chartPagePanelsDefaults();
    return {
      sideOpen: typeof o.sideOpen === 'boolean' ? o.sideOpen : d.sideOpen,
      extrasOpen: typeof o.extrasOpen === 'boolean' ? o.extrasOpen : d.extrasOpen,
      heights: o.heights,
    };
  } catch {
    return chartPagePanelsDefaults();
  }
}

export function loadChartSectionHeights(storageKey: string): ChartSectionHeights {
  const p = loadChartPagePanels(storageKey);
  const d = chartSectionHeightsDefaults();
  const h = p.heights;
  if (!h) return d;
  return {
    mainTall: typeof h.mainTall === 'boolean' ? h.mainTall : d.mainTall,
    histTall: typeof h.histTall === 'boolean' ? h.histTall : d.histTall,
    activityTall: typeof h.activityTall === 'boolean' ? h.activityTall : d.activityTall,
  };
}

export function persistChartPagePanels(storageKey: string, panels: ChartPagePanels): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(panels));
  } catch {
    /* ignore */
  }
}
