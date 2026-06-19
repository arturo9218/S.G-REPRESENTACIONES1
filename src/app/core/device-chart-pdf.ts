export type DeviceChartPdfColumn = {
  header: string;
  cell: (row: Record<string, unknown>) => string;
};

function evenSampleRows<T>(sorted: T[], max: number): T[] {
  if (sorted.length <= max) return sorted;
  const out: T[] = [];
  const last = sorted.length - 1;
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * last) / (max - 1));
    out.push(sorted[idx]);
  }
  return out;
}

function formatPdfDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function pdfDateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export type DownloadDeviceChartPdfOpts = {
  title: string;
  deviceName: string;
  rangeLabel: string;
  styleLabel: string;
  rows: Record<string, unknown>[];
  columns: DeviceChartPdfColumn[];
  fileSlug: string;
  captureEl?: HTMLElement | null;
  maxRows?: number;
};

/** PDF histórico: tabla de lecturas + captura opcional del gráfico. */
export async function downloadDeviceChartPdf(opts: DownloadDeviceChartPdfOpts): Promise<void> {
  const maxRows = opts.maxRows ?? 4000;
  let rows = [...opts.rows];
  if (!rows.length) {
    alert('No hay lecturas en el rango para exportar.');
    return;
  }
  const rawLen = rows.length;
  rows = evenSampleRows(rows, maxRows);
  let note = '';
  if (rawLen > maxRows) {
    note = `Tabla: muestreo uniforme (${maxRows} de ${rawLen} lecturas).`;
  }

  let chartImgData: string | null = null;
  let chartImgW = 0;
  let chartImgH = 0;
  let chartCaptureFailed = false;
  if (opts.captureEl) {
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(opts.captureEl, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#0f172a',
      });
      chartImgData = canvas.toDataURL('image/png');
      chartImgW = canvas.width;
      chartImgH = canvas.height;
    } catch {
      chartCaptureFailed = true;
    }
  }

  const [jspdfMod, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const JsPDF = jspdfMod.default;
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 16;

  doc.setFontSize(14);
  doc.text(opts.title, margin, y);
  y += 8;
  doc.setFontSize(10);
  doc.text(`Equipo: ${opts.deviceName}`, margin, y);
  y += 5;
  doc.setFontSize(8);
  doc.setTextColor(80);
  doc.text(
    `Generado: ${new Date().toLocaleString('es-AR')} · ${rows.length} lecturas · ${opts.rangeLabel} · ${opts.styleLabel}`,
    margin,
    y
  );
  if (note) {
    y += 4;
    doc.text(note, margin, y);
  }
  doc.setTextColor(0);
  y += 6;

  if (chartImgData && chartImgW > 0 && chartImgH > 0) {
    const maxW = pageW - margin * 2;
    const imgH = (chartImgH * maxW) / chartImgW;
    const maxImgH = 70;
    const drawW = imgH > maxImgH ? (maxW * maxImgH) / imgH : maxW;
    const drawH = imgH > maxImgH ? maxImgH : imgH;
    doc.addImage(chartImgData, 'PNG', margin, y, drawW, drawH);
    y += drawH + 6;
  }

  const head = [opts.columns.map((c) => c.header)];
  const body = rows.map((row) => opts.columns.map((c) => c.cell(row)));

  autoTable(doc, {
    startY: y,
    head,
    body,
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [30, 58, 138], textColor: 255 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    margin: { left: margin, right: margin },
  });

  const safe = opts.fileSlug.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]+/gi, '_').replace(/_+/g, '_').slice(0, 48);
  doc.save(`historial_${safe}_${pdfDateStamp()}.pdf`);

  if (chartCaptureFailed) {
    alert(
      'PDF guardado con la tabla de datos. No se pudo capturar la imagen del gráfico (probá pantalla completa u otro navegador).'
    );
  }
}

export function pdfCellDate(iso: unknown): string {
  return typeof iso === 'string' && iso.trim() ? formatPdfDateTime(iso) : '—';
}

export function pdfCellNum(v: unknown, digits = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

export function pdfCellOn(v: unknown): string {
  if (v === true || v === 1) return 'ON';
  if (v === false || v === 0) return 'OFF';
  return '—';
}
