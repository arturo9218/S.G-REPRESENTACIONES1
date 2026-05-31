import type { PtPoint } from './refrigerant-pt.utils';

export type RefrigerantCategory = 'hfcs' | 'naturales' | 'baja' | 'legacy';

export interface RefrigerantDefinition {
  id: string;
  label: string;
  category: RefrigerantCategory;
  /** Valor en select de Ficha equipo; default = label sin paréntesis. */
  fichaValue?: string;
  points: readonly PtPoint[];
  note?: string;
}

export const REFRIGERANT_CATEGORY_LABELS: Record<RefrigerantCategory, string> = {
  hfcs: 'HFC, HFO y mezclas',
  naturales: 'Naturales (NH₃, CO₂, hidrocarburos)',
  baja: 'Baja temperatura',
  legacy: 'Retirados y sustitutos',
};

/**
 * Tablas P–T orientativas (presión absoluta bar vs °C). Interpolación lineal.
 * No reemplazan catálogo del fabricante.
 */
export const REFRIGERANTS: RefrigerantDefinition[] = [
  { id: 'r32', label: 'R32', category: 'hfcs', points: [
    { t: -20, p: 1.54 }, { t: -10, p: 2.12 }, { t: 0, p: 2.89 }, { t: 10, p: 3.87 },
    { t: 20, p: 5.10 }, { t: 30, p: 6.62 }, { t: 40, p: 8.48 }, { t: 50, p: 10.74 },
  ]},
  { id: 'r134a', label: 'R134a', category: 'hfcs', points: [
    { t: -30, p: 0.37 }, { t: -20, p: 0.57 }, { t: -10, p: 0.87 }, { t: 0, p: 1.29 },
    { t: 10, p: 1.85 }, { t: 20, p: 2.57 }, { t: 30, p: 3.49 }, { t: 40, p: 4.66 }, { t: 50, p: 6.13 },
  ]},
  { id: 'r404a', label: 'R404A', category: 'hfcs', points: [
    { t: -40, p: 0.55 }, { t: -30, p: 0.84 }, { t: -20, p: 1.24 }, { t: -10, p: 1.79 },
    { t: 0, p: 2.52 }, { t: 10, p: 3.48 }, { t: 20, p: 4.72 }, { t: 30, p: 6.30 }, { t: 40, p: 8.28 },
  ]},
  { id: 'r407a', label: 'R407A', category: 'hfcs', note: 'Mezcla zeotrópica.', points: [
    { t: -30, p: 0.56 }, { t: -20, p: 0.86 }, { t: -10, p: 1.26 }, { t: 0, p: 1.80 },
    { t: 10, p: 2.51 }, { t: 20, p: 3.44 }, { t: 30, p: 4.64 }, { t: 40, p: 6.15 },
  ]},
  { id: 'r407c', label: 'R407C', category: 'hfcs', note: 'Mezcla zeotrópica.', points: [
    { t: -30, p: 0.58 }, { t: -20, p: 0.88 }, { t: -10, p: 1.28 }, { t: 0, p: 1.82 },
    { t: 10, p: 2.54 }, { t: 20, p: 3.48 }, { t: 30, p: 4.69 }, { t: 40, p: 6.22 },
  ]},
  { id: 'r407f', label: 'R407F', category: 'hfcs', points: [
    { t: -30, p: 0.52 }, { t: -20, p: 0.79 }, { t: -10, p: 1.16 }, { t: 0, p: 1.66 },
    { t: 10, p: 2.33 }, { t: 20, p: 3.21 }, { t: 30, p: 4.35 }, { t: 40, p: 5.81 },
  ]},
  { id: 'r410a', label: 'R410A', category: 'hfcs', note: 'Zeotrópico; referencia aproximada.', points: [
    { t: -20, p: 1.44 }, { t: -10, p: 1.98 }, { t: 0, p: 2.67 }, { t: 10, p: 3.55 },
    { t: 20, p: 4.66 }, { t: 30, p: 6.03 }, { t: 40, p: 7.71 }, { t: 50, p: 9.76 },
  ]},
  { id: 'r448a', label: 'R448A', category: 'hfcs', points: [
    { t: -30, p: 0.50 }, { t: -20, p: 0.76 }, { t: -10, p: 1.12 }, { t: 0, p: 1.61 },
    { t: 10, p: 2.27 }, { t: 20, p: 3.13 }, { t: 30, p: 4.25 }, { t: 40, p: 5.70 },
  ]},
  { id: 'r449a', label: 'R449A', category: 'hfcs', points: [
    { t: -30, p: 0.54 }, { t: -20, p: 0.82 }, { t: -10, p: 1.20 }, { t: 0, p: 1.72 },
    { t: 10, p: 2.41 }, { t: 20, p: 3.31 }, { t: 30, p: 4.48 }, { t: 40, p: 5.98 },
  ]},
  { id: 'r452a', label: 'R452A', category: 'hfcs', points: [
    { t: -30, p: 0.48 }, { t: -20, p: 0.73 }, { t: -10, p: 1.07 }, { t: 0, p: 1.54 },
    { t: 10, p: 2.17 }, { t: 20, p: 2.99 }, { t: 30, p: 4.05 }, { t: 40, p: 5.41 },
  ]},
  { id: 'r454a', label: 'R454A', category: 'hfcs', note: 'A2L. Presiones similares a R410A.', points: [
    { t: -20, p: 1.38 }, { t: -10, p: 1.90 }, { t: 0, p: 2.56 }, { t: 10, p: 3.40 },
    { t: 20, p: 4.46 }, { t: 30, p: 5.78 }, { t: 40, p: 7.38 },
  ]},
  { id: 'r454b', label: 'R454B', category: 'hfcs', fichaValue: 'R454B', note: 'A2L. Sustituto de R410A.', points: [
    { t: -20, p: 1.32 }, { t: -10, p: 1.82 }, { t: 0, p: 2.45 }, { t: 10, p: 3.26 },
    { t: 20, p: 4.28 }, { t: 30, p: 5.55 }, { t: 40, p: 7.10 }, { t: 50, p: 8.95 },
  ]},
  { id: 'r454c', label: 'R454C', category: 'hfcs', fichaValue: 'R454C', note: 'A2L.', points: [
    { t: -20, p: 1.30 }, { t: -10, p: 1.78 }, { t: 0, p: 2.40 }, { t: 10, p: 3.18 },
    { t: 20, p: 4.18 }, { t: 30, p: 5.42 }, { t: 40, p: 6.92 },
  ]},
  { id: 'r513a', label: 'R513A', category: 'hfcs', points: [
    { t: -20, p: 0.55 }, { t: -10, p: 0.82 }, { t: 0, p: 1.19 }, { t: 10, p: 1.69 },
    { t: 20, p: 2.35 }, { t: 30, p: 3.21 }, { t: 40, p: 4.32 }, { t: 50, p: 5.74 },
  ]},
  { id: 'r507', label: 'R507 / R507A', category: 'hfcs', fichaValue: 'R507', points: [
    { t: -40, p: 0.50 }, { t: -30, p: 0.76 }, { t: -20, p: 1.12 }, { t: -10, p: 1.62 },
    { t: 0, p: 2.29 }, { t: 10, p: 3.16 }, { t: 20, p: 4.29 }, { t: 30, p: 5.74 }, { t: 40, p: 7.55 },
  ]},
  { id: 'r744', label: 'R744 (CO₂)', category: 'naturales', fichaValue: 'R744', note: 'Subcrítico hasta ~31 °C. Por encima: ciclo transcrítico (esta tabla no aplica).', points: [
    { t: -40, p: 5.48 }, { t: -35, p: 5.98 }, { t: -30, p: 6.54 }, { t: -25, p: 7.15 },
    { t: -20, p: 7.82 }, { t: -15, p: 8.55 }, { t: -10, p: 9.35 }, { t: -5, p: 10.22 },
    { t: 0, p: 11.17 }, { t: 5, p: 12.20 }, { t: 10, p: 13.31 }, { t: 15, p: 14.51 },
    { t: 20, p: 15.81 }, { t: 25, p: 17.22 }, { t: 30, p: 18.74 },
  ]},
  { id: 'r717', label: 'R717 (amoniaco)', category: 'naturales', fichaValue: 'R717', note: 'Tóxico. EPP y procedimientos específicos.', points: [
    { t: -40, p: 0.36 }, { t: -30, p: 0.55 }, { t: -20, p: 0.83 }, { t: -10, p: 1.22 },
    { t: 0, p: 1.76 }, { t: 10, p: 2.49 }, { t: 20, p: 3.45 }, { t: 30, p: 4.70 },
  ]},
  { id: 'r290', label: 'R290 (propano)', category: 'naturales', fichaValue: 'R290', note: 'Inflamable.', points: [
    { t: -30, p: 0.28 }, { t: -20, p: 0.43 }, { t: -10, p: 0.64 }, { t: 0, p: 0.93 },
    { t: 10, p: 1.33 }, { t: 20, p: 1.86 }, { t: 30, p: 2.55 }, { t: 40, p: 3.44 },
  ]},
  { id: 'r600a', label: 'R600a (isobutano)', category: 'naturales', fichaValue: 'R600a', note: 'Inflamable.', points: [
    { t: -30, p: 0.16 }, { t: -20, p: 0.26 }, { t: -10, p: 0.40 }, { t: 0, p: 0.60 },
    { t: 10, p: 0.88 }, { t: 20, p: 1.26 }, { t: 30, p: 1.77 }, { t: 40, p: 2.44 },
  ]},
  { id: 'r1270', label: 'R1270 (propileno)', category: 'naturales', fichaValue: 'R1270', note: 'Inflamable.', points: [
    { t: -30, p: 0.26 }, { t: -20, p: 0.40 }, { t: -10, p: 0.60 }, { t: 0, p: 0.87 },
    { t: 10, p: 1.24 }, { t: 20, p: 1.74 }, { t: 30, p: 2.38 }, { t: 40, p: 3.22 },
  ]},
  { id: 'r23', label: 'R23', category: 'baja', fichaValue: 'R23', points: [
    { t: -80, p: 0.37 }, { t: -70, p: 0.58 }, { t: -60, p: 0.88 }, { t: -50, p: 1.32 },
    { t: -40, p: 1.94 }, { t: -30, p: 2.80 }, { t: -20, p: 3.98 }, { t: -10, p: 5.55 }, { t: 0, p: 7.62 },
  ]},
  { id: 'r508b', label: 'R508B', category: 'baja', fichaValue: 'R508B', points: [
    { t: -90, p: 0.24 }, { t: -80, p: 0.38 }, { t: -70, p: 0.58 }, { t: -60, p: 0.87 },
    { t: -50, p: 1.28 }, { t: -40, p: 1.85 }, { t: -30, p: 2.62 }, { t: -20, p: 3.65 },
  ]},
  { id: 'r22', label: 'R22', category: 'legacy', points: [
    { t: -30, p: 0.49 }, { t: -20, p: 0.74 }, { t: -10, p: 1.09 }, { t: 0, p: 1.58 },
    { t: 10, p: 2.24 }, { t: 20, p: 3.10 }, { t: 30, p: 4.22 }, { t: 40, p: 5.67 }, { t: 50, p: 7.52 },
  ]},
  { id: 'r401a', label: 'R401A', category: 'legacy', fichaValue: 'R401A', points: [
    { t: -30, p: 0.42 }, { t: -20, p: 0.64 }, { t: -10, p: 0.95 }, { t: 0, p: 1.38 },
    { t: 10, p: 1.96 }, { t: 20, p: 2.72 }, { t: 30, p: 3.70 },
  ]},
  { id: 'r409a', label: 'R409A', category: 'legacy', fichaValue: 'R409A', points: [
    { t: -30, p: 0.46 }, { t: -20, p: 0.70 }, { t: -10, p: 1.03 }, { t: 0, p: 1.50 },
    { t: 10, p: 2.12 }, { t: 20, p: 2.94 }, { t: 30, p: 4.00 },
  ]},
  { id: 'r417a', label: 'R417A', category: 'legacy', fichaValue: 'R417A', points: [
    { t: -30, p: 0.48 }, { t: -20, p: 0.73 }, { t: -10, p: 1.07 }, { t: 0, p: 1.55 },
    { t: 10, p: 2.19 }, { t: 20, p: 3.03 }, { t: 30, p: 4.12 },
  ]},
  { id: 'r422d', label: 'R422D', category: 'legacy', fichaValue: 'R422D', points: [
    { t: -30, p: 0.52 }, { t: -20, p: 0.79 }, { t: -10, p: 1.16 }, { t: 0, p: 1.67 },
    { t: 10, p: 2.35 }, { t: 20, p: 3.24 }, { t: 30, p: 4.38 },
  ]},
  { id: 'r423a', label: 'R423A', category: 'legacy', fichaValue: 'R423A', points: [
    { t: -30, p: 0.40 }, { t: -20, p: 0.61 }, { t: -10, p: 0.90 }, { t: 0, p: 1.31 },
    { t: 10, p: 1.86 }, { t: 20, p: 2.58 }, { t: 30, p: 3.50 },
  ]},
  { id: 'r438a', label: 'R438A', category: 'legacy', fichaValue: 'R438A', points: [
    { t: -30, p: 0.50 }, { t: -20, p: 0.75 }, { t: -10, p: 1.10 }, { t: 0, p: 1.59 },
    { t: 10, p: 2.25 }, { t: 20, p: 3.11 }, { t: 30, p: 4.22 },
  ]},
  { id: 'r500', label: 'R500', category: 'legacy', fichaValue: 'R500', points: [
    { t: -30, p: 0.38 }, { t: -20, p: 0.58 }, { t: -10, p: 0.86 }, { t: 0, p: 1.24 },
    { t: 10, p: 1.76 }, { t: 20, p: 2.44 }, { t: 30, p: 3.30 },
  ]},
  { id: 'r502', label: 'R502', category: 'legacy', fichaValue: 'R502', points: [
    { t: -40, p: 0.28 }, { t: -30, p: 0.45 }, { t: -20, p: 0.69 }, { t: -10, p: 1.02 },
    { t: 0, p: 1.47 }, { t: 10, p: 2.08 }, { t: 20, p: 2.89 }, { t: 30, p: 3.96 },
  ]},
  { id: 'r503', label: 'R503', category: 'legacy', fichaValue: 'R503', points: [
    { t: -50, p: 0.35 }, { t: -40, p: 0.55 }, { t: -30, p: 0.84 }, { t: -20, p: 1.24 },
    { t: -10, p: 1.78 }, { t: 0, p: 2.50 }, { t: 10, p: 3.45 },
  ]},
];

export function refrigerantById(id: string): RefrigerantDefinition | undefined {
  return REFRIGERANTS.find((r) => r.id === id);
}

export function refrigerantFichaValue(ref: RefrigerantDefinition): string {
  if (ref.fichaValue) return ref.fichaValue;
  return ref.label.replace(/\s*\(.+\)$/, '').split('/')[0].trim();
}

/** Resuelve el id interno del refrigerante desde el texto guardado en ficha. */
export function refrigerantIdFromFichaValue(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/\s+/g, '');
  for (const r of REFRIGERANTS) {
    if (r.id === norm || r.id.replace(/\s/g, '') === norm) return r.id;
    const ficha = refrigerantFichaValue(r).toLowerCase().replace(/\s+/g, '');
    const label = r.label.toLowerCase().replace(/\s+/g, '');
    if (norm === ficha || norm === label || label.includes(norm) || ficha.includes(norm)) {
      return r.id;
    }
  }
  return null;
}

export function refrigerantsGrouped(filter = ''): {
  category: RefrigerantCategory;
  label: string;
  items: RefrigerantDefinition[];
}[] {
  const q = filter.trim().toLowerCase();
  const order: RefrigerantCategory[] = ['hfcs', 'naturales', 'baja', 'legacy'];
  return order
    .map((cat) => ({
      category: cat,
      label: REFRIGERANT_CATEGORY_LABELS[cat],
      items: REFRIGERANTS.filter((r) => {
        if (r.category !== cat) return false;
        if (!q) return true;
        return (
          r.label.toLowerCase().includes(q) ||
          r.id.includes(q) ||
          (r.fichaValue?.toLowerCase().includes(q) ?? false)
        );
      }).sort((a, b) => a.label.localeCompare(b.label, 'es')),
    }))
    .filter((g) => g.items.length > 0);
}

export function filterRefrigerants(filter = ''): RefrigerantDefinition[] {
  const q = filter.trim().toLowerCase();
  if (!q) return [...REFRIGERANTS].sort((a, b) => a.label.localeCompare(b.label, 'es'));
  return REFRIGERANTS.filter(
    (r) =>
      r.label.toLowerCase().includes(q) ||
      r.id.includes(q) ||
      (r.fichaValue?.toLowerCase().includes(q) ?? false)
  ).sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
