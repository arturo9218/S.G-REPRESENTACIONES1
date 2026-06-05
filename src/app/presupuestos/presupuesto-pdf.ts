import { systemTypeLabel } from './presupuesto-circuit.catalog';
import type { CircuitSectionState } from './presupuesto-circuit.models';
import {
  activeComponents,
  componentStatusLabel,
  sectionHasContent,
  surveyHasContent,
} from './presupuesto-circuit.utils';
import type { PresupuestoRow } from './presupuesto.models';
import { computeTotals, formatMoney, lineTotal } from './presupuesto.utils';

function detectImageFormat(dataUrl: string): 'PNG' | 'JPEG' | 'WEBP' {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
}

function appendSectionPdf(
  doc: import('jspdf').jsPDF,
  margin: number,
  y: number,
  title: string,
  lines: string[]
): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y > pageH - 30) {
    doc.addPage();
    y = 18;
  }
  doc.setFontSize(11);
  doc.setTextColor(30, 64, 175);
  doc.text(title, margin, y);
  y += 6;
  doc.setFontSize(9);
  doc.setTextColor(0);
  for (const line of lines) {
    if (!line.trim()) continue;
    const wrapped = doc.splitTextToSize(line, 182);
    if (y + wrapped.length * 4.2 > pageH - 15) {
      doc.addPage();
      y = 18;
    }
    doc.text(wrapped, margin, y);
    y += wrapped.length * 4.2 + 1;
  }
  return y + 4;
}

function circuitSectionLines(sec: CircuitSectionState): string[] {
  const lines: string[] = [];
  if (sec.composition.trim()) lines.push(`Composición: ${sec.composition.trim()}`);
  if (sec.problemReported.trim()) lines.push(`Problema: ${sec.problemReported.trim()}`);
  if (sec.workProposed.trim()) lines.push(`Trabajo propuesto: ${sec.workProposed.trim()}`);
  for (const c of activeComponents(sec)) {
    const st = componentStatusLabel(c.status);
    const note = c.notes.trim() ? ` — ${c.notes.trim()}` : '';
    lines.push(`• ${c.label}: ${c.present ? 'Presente' : '—'}, ${st}${note}`);
  }
  return lines;
}

export async function downloadPresupuestoPdf(row: PresupuestoRow): Promise<void> {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const totals = computeTotals(row.items, row.taxPercent, row.discountPercent);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 14;
  let y = 16;
  const prof = row.professional;
  const headerTitle = prof.companyName.trim() || 'AR Monitoreo';

  if (prof.logoDataUrl) {
    try {
      const fmt = detectImageFormat(prof.logoDataUrl);
      doc.addImage(prof.logoDataUrl, fmt, margin, y, 42, 18);
      y += 22;
    } catch {
      /* logo inválido */
    }
  }

  doc.setFontSize(16);
  doc.setTextColor(0);
  doc.text(headerTitle, margin, y);
  y += 7;
  doc.setFontSize(13);
  doc.text('Presupuesto técnico — refrigeración', margin, y);
  y += 6;

  if (prof.technicianName.trim()) {
    doc.setFontSize(9);
    doc.setTextColor(80);
    const tech = [
      `Técnico: ${prof.technicianName.trim()}`,
      prof.technicianLicense.trim() ? `Mat. / reg.: ${prof.technicianLicense.trim()}` : '',
      prof.technicianPhone.trim() ? `Tel: ${prof.technicianPhone.trim()}` : '',
      prof.technicianEmail.trim() ? prof.technicianEmail.trim() : '',
    ]
      .filter(Boolean)
      .join(' · ');
    doc.text(tech, margin, y);
    y += 6;
  }

  doc.setFontSize(9);
  doc.setTextColor(100);
  const ref = row.referenceCode ? `Ref: ${row.referenceCode}` : '';
  doc.text(
    [ref, `Estado: ${row.status}`, `Fecha: ${new Date().toLocaleDateString('es-AR')}`]
      .filter(Boolean)
      .join(' · '),
    margin,
    y
  );
  y += 9;
  doc.setTextColor(0);

  const sysLabel = systemTypeLabel(row.systemType, row.systemTypeOther ?? undefined);
  if (row.systemType) {
    y = appendSectionPdf(doc, margin, y, 'Instalación', [
      `Tipo: ${sysLabel}`,
      row.refrigerant ? `Refrigerante: ${row.refrigerant}` : '',
      row.nominalCapacity ? `Capacidad / potencia: ${row.nominalCapacity}` : '',
    ]);
  }

  if (surveyHasContent(row.circuitSurvey)) {
    y = appendSectionPdf(doc, margin, y, 'Relevamiento del circuito frigorífico', []);
    if (row.circuitSurvey.generalProblem.trim()) {
      y = appendSectionPdf(doc, margin, y, 'Problema reportado', [row.circuitSurvey.generalProblem]);
    }
    if (row.circuitSurvey.generalDiagnosis.trim()) {
      y = appendSectionPdf(doc, margin, y, 'Diagnóstico', [row.circuitSurvey.generalDiagnosis]);
    }
    for (const sec of row.circuitSurvey.sections) {
      if (!sectionHasContent(sec)) continue;
      y = appendSectionPdf(doc, margin, y, sec.title, circuitSectionLines(sec));
    }
  }

  y = appendSectionPdf(doc, margin, y, 'Cliente', [
    row.clientName,
    row.clientPhone ? `Tel: ${row.clientPhone}` : '',
    row.clientEmail ? `Email: ${row.clientEmail}` : '',
    row.siteAddress ? `Obra: ${row.siteAddress}` : '',
    row.workDescription ? `Trabajo: ${row.workDescription}` : '',
  ]);

  if (y > 240) {
    doc.addPage();
    y = 18;
  }

  autoTable(doc, {
    startY: y,
    head: [['Descripción', 'Cant.', 'P. unit.', 'Importe']],
    body: row.items.map((i) => [
      i.description,
      `${i.quantity} ${i.unit}`,
      formatMoney(i.unitPrice, row.currency),
      formatMoney(lineTotal(i), row.currency),
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [37, 99, 235] },
    margin: { left: margin, right: margin },
  });

  y = (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 20;
  y += 8;
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text(`Subtotal: ${formatMoney(totals.subtotal, row.currency)}`, margin, y);
  y += 5;
  if (totals.discountAmount > 0) {
    doc.text(
      `Descuento (${row.discountPercent}%): -${formatMoney(totals.discountAmount, row.currency)}`,
      margin,
      y
    );
    y += 5;
  }
  doc.text(`IVA (${row.taxPercent}%): ${formatMoney(totals.taxAmount, row.currency)}`, margin, y);
  y += 7;
  doc.setFontSize(12);
  doc.text(`TOTAL: ${formatMoney(totals.total, row.currency)}`, margin, y);
  y += 8;

  if (row.validUntil) {
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`Válido hasta: ${row.validUntil}`, margin, y);
    y += 5;
  }
  if (row.notes) {
    const lines = doc.splitTextToSize(`Observaciones: ${row.notes}`, 182);
    doc.text(lines, margin, y);
  }

  const fname = `presupuesto-${row.referenceCode || row.id.slice(0, 8)}.pdf`;
  doc.save(fname);
}
