import type { PresupuestoLineItem, PresupuestoRow } from './presupuesto.models';

/** Campos recomendados antes del PDF; el usuario puede omitirlos. */
export function collectMissingPdfFields(
  row: PresupuestoRow,
  items: PresupuestoLineItem[]
): string[] {
  const missing: string[] = [];
  if (!row.professional.technicianName.trim()) {
    missing.push('Técnico responsable');
  }
  if (!row.professional.companyName.trim()) {
    missing.push('Empresa / taller');
  }
  if (!row.systemType) {
    missing.push('Tipo de instalación');
  }
  if (row.systemType === 'otro' && !row.systemTypeOther?.trim()) {
    missing.push('Descripción del sistema (otro)');
  }
  if (!row.clientName.trim() || row.clientName === 'Cliente') {
    missing.push('Nombre del cliente');
  }
  const hasItems = items.some((i) => i.description.trim() || i.unitPrice > 0);
  if (!hasItems) {
    missing.push('Ítems presupuestados (descripción o importe)');
  }
  if (!row.siteAddress?.trim()) {
    missing.push('Dirección / obra');
  }
  return missing;
}

export function confirmPdfDespiteMissing(missing: string[]): boolean {
  if (!missing.length) return true;
  const list = missing.map((m) => `• ${m}`).join('\n');
  return confirm(
    `Faltan datos recomendados:\n\n${list}\n\n¿Descargar el PDF igual?`
  );
}
