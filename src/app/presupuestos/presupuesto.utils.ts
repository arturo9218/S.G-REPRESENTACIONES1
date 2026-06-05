import type { PresupuestoLineItem, PresupuestoTotals } from './presupuesto.models';

export function newLineItem(): PresupuestoLineItem {
  return {
    id: crypto.randomUUID(),
    description: '',
    quantity: 1,
    unit: 'u.',
    unitPrice: 0,
  };
}

export function parseItems(raw: unknown): PresupuestoLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const o = row as Record<string, unknown>;
      const qty = Number(o['quantity']);
      const price = Number(o['unitPrice'] ?? o['unit_price']);
      return {
        id: String(o['id'] ?? crypto.randomUUID()),
        description: String(o['description'] ?? '').trim(),
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        unit: String(o['unit'] ?? 'u.').trim() || 'u.',
        unitPrice: Number.isFinite(price) ? price : 0,
      };
    })
    .filter((i) => i.description || i.unitPrice > 0);
}

export function lineTotal(item: PresupuestoLineItem): number {
  const q = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
  const p = Number.isFinite(item.unitPrice) ? item.unitPrice : 0;
  return Math.round(q * p * 100) / 100;
}

export function computeTotals(
  items: PresupuestoLineItem[],
  taxPercent: number,
  discountPercent: number
): PresupuestoTotals {
  const subtotal = items.reduce((s, i) => s + lineTotal(i), 0);
  const discPct = Number.isFinite(discountPercent) ? Math.max(0, discountPercent) : 0;
  const taxPct = Number.isFinite(taxPercent) ? Math.max(0, taxPercent) : 0;
  const discountAmount = Math.round(subtotal * (discPct / 100) * 100) / 100;
  const taxable = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const taxAmount = Math.round(taxable * (taxPct / 100) * 100) / 100;
  const total = Math.round((taxable + taxAmount) * 100) / 100;
  return { subtotal, discountAmount, taxable, taxAmount, total };
}

export function formatMoney(value: number, currency = 'ARS'): string {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency === 'USD' ? 'USD' : 'ARS',
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function defaultReferenceCode(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const r = Math.floor(Math.random() * 9000) + 1000;
  return `AR-${y}${m}${day}-${r}`;
}
