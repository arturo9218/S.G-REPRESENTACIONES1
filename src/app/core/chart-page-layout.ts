export type ChartPagePanels = {
  sideOpen: boolean;
  extrasOpen: boolean;
};

export function chartPagePanelsDefaults(): ChartPagePanels {
  return { sideOpen: false, extrasOpen: false };
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
    };
  } catch {
    return chartPagePanelsDefaults();
  }
}

export function persistChartPagePanels(storageKey: string, panels: ChartPagePanels): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(panels));
  } catch {
    /* ignore */
  }
}
