import type { InicioDeviceManual, InicioManualBlock, InicioManualItem } from './inicio-device-manual';

const COLORS = {
  primary: [15, 23, 42] as [number, number, number],
  accent: [37, 99, 235] as [number, number, number],
  text: [30, 41, 59] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  border: [203, 213, 225] as [number, number, number],
  cardBg: [248, 250, 252] as [number, number, number],
  exampleBg: [239, 246, 255] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
};

type JsPDFDoc = import('jspdf').jsPDF;
type AutoTableFn = (doc: JsPDFDoc, options: Record<string, unknown>) => void;

interface TocEntry {
  title: string;
  page: number;
}

/** Normaliza unicode que a veces rompe el ancho de línea en jsPDF. */
function pdfSafe(text: string): string {
  return text
    .replace(/\u2026/g, '...')
    .replace(/\u2014/g, ' - ')
    .replace(/\u2013/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2192/g, '->')
    .replace(/\u00A0/g, ' ');
}

function lastTableY(doc: JsPDFDoc): number {
  const t = (doc as JsPDFDoc & { lastAutoTable?: { finalY: number } }).lastAutoTable;
  return t?.finalY ?? 0;
}

class ManualPdfRenderer {
  private readonly marginL = 18;
  private readonly marginR = 18;
  private readonly marginTop = 22;
  private readonly marginBottom = 14;
  private readonly footerH = 10;
  private readonly pageW: number;
  private readonly pageH: number;
  private readonly contentW: number;
  private y = 0;
  private readonly toc: TocEntry[] = [];
  private readonly autoTable: AutoTableFn;

  constructor(
    private readonly doc: JsPDFDoc,
    private readonly manual: InicioDeviceManual,
    autoTable: AutoTableFn
  ) {
    this.autoTable = autoTable;
    this.pageW = doc.internal.pageSize.getWidth();
    this.pageH = doc.internal.pageSize.getHeight();
    this.contentW = this.pageW - this.marginL - this.marginR;
  }

  render(): void {
    this.drawCover();
    this.doc.addPage();
    this.y = this.marginTop;

    for (let i = 0; i < this.manual.blocks.length; i++) {
      this.drawBlock(this.manual.blocks[i], i + 1);
    }

    this.insertTableOfContents();
    this.drawAllFooters();
  }

  private tableMargin(): { left: number; right: number } {
    return { left: this.marginL, right: this.marginR };
  }

  private plainTable(body: string[][], startY: number, fontSize = 10): number {
    this.autoTable(this.doc, {
      startY,
      margin: this.tableMargin(),
      theme: 'plain',
      body: body.map((row) => row.map(pdfSafe)),
      styles: {
        font: 'helvetica',
        fontSize,
        cellPadding: { top: 2, right: 3, bottom: 2, left: 3 },
        overflow: 'linebreak',
        cellWidth: 'wrap',
        valign: 'top',
        textColor: COLORS.text,
        lineWidth: 0,
      },
    });
    return lastTableY(this.doc);
  }

  private contentBottomLimit(): number {
    return this.pageH - this.marginBottom - this.footerH;
  }

  private ensureTableFits(estimatedMm = 25): void {
    if (this.y + estimatedMm > this.contentBottomLimit()) {
      this.doc.addPage();
      this.y = this.marginTop;
    }
  }

  private drawCover(): void {
    const bandH = 72;
    this.doc.setFillColor(...COLORS.primary);
    this.doc.rect(0, 0, this.pageW, bandH, 'F');

    this.doc.setTextColor(...COLORS.white);
    this.doc.setFont('helvetica', 'bold');
    this.doc.setFontSize(18);
    const titleLines = this.doc.splitTextToSize(pdfSafe(this.manual.title), this.pageW - 36);
    let ty = 28;
    for (const line of titleLines) {
      this.doc.text(line, this.marginL, ty);
      ty += 7;
    }

    this.doc.setFont('helvetica', 'normal');
    this.doc.setFontSize(11);
    this.doc.text(pdfSafe(this.manual.subtitle), this.marginL, ty + 2);

    const generated = new Date().toLocaleString('es-AR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    this.doc.setFontSize(9);
    this.doc.setTextColor(...COLORS.muted);
    this.doc.text(`Generado: ${generated}`, this.marginL, this.pageH - 14);
    this.doc.text('Documento para operadores y tecnicos de planta', this.marginL, this.pageH - 9);
  }

  private insertTableOfContents(): void {
    if (!this.toc.length) return;

    const rows = this.toc.map((e) => [
      pdfSafe(e.title),
      String(e.page >= 2 ? e.page + 1 : e.page),
    ]);

    this.doc.insertPage(2);
    this.doc.setPage(2);
    this.y = this.marginTop;

    this.doc.setFillColor(...COLORS.primary);
    this.doc.rect(this.marginL, this.y, this.contentW, 10, 'F');
    this.doc.setFont('helvetica', 'bold');
    this.doc.setFontSize(13);
    this.doc.setTextColor(...COLORS.white);
    this.doc.text('Indice', this.marginL + 4, this.y + 7);
    this.y += 14;

    this.autoTable(this.doc, {
      startY: this.y,
      margin: this.tableMargin(),
      theme: 'plain',
      head: [['Seccion', 'Pag.']],
      body: rows,
      headStyles: {
        fillColor: COLORS.primary,
        textColor: COLORS.white,
        fontStyle: 'bold',
        fontSize: 9,
      },
      styles: {
        font: 'helvetica',
        fontSize: 10,
        cellPadding: 3,
        overflow: 'linebreak',
        valign: 'middle',
        textColor: COLORS.text,
        lineColor: COLORS.border,
        lineWidth: 0.1,
      },
      columnStyles: {
        0: { cellWidth: this.contentW - 18 },
        1: { cellWidth: 18, halign: 'center', fontStyle: 'bold', textColor: COLORS.accent },
      },
    });
  }

  private drawAllFooters(): void {
    const total = this.doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      this.doc.setPage(p);
      if (p === 1) continue;

      const footerY = this.pageH - 8;
      this.doc.setDrawColor(...COLORS.border);
      this.doc.setLineWidth(0.15);
      this.doc.line(this.marginL, footerY - 4, this.pageW - this.marginR, footerY - 4);

      this.doc.setFont('helvetica', 'normal');
      this.doc.setFontSize(8);
      this.doc.setTextColor(...COLORS.muted);
      this.doc.text('AR Monitoreo', this.marginL, footerY);

      const pageLabel = `Pagina ${p} de ${total}`;
      this.doc.setFontSize(8);
      const labelW = this.doc.getTextWidth(pageLabel);
      this.doc.text(pageLabel, this.pageW - this.marginR - labelW, footerY);
    }
  }

  private drawBlock(block: InicioManualBlock, blockNum: number): void {
    this.toc.push({
      title: `${blockNum}. ${block.title}`,
      page: this.doc.getNumberOfPages(),
    });

    this.ensureTableFits(20);
    const barY = this.y;
    this.doc.setFillColor(...COLORS.accent);
    this.doc.rect(this.marginL, barY, this.contentW, 9, 'F');
    this.doc.setFont('helvetica', 'bold');
    this.doc.setFontSize(11);
    this.doc.setTextColor(...COLORS.white);
    this.doc.text(pdfSafe(`${blockNum}. ${block.title}`), this.marginL + 3, barY + 6.2);
    this.y = barY + 11;

    if (block.intro?.trim()) {
      this.ensureTableFits(15);
      this.y =
        this.plainTable([[block.intro.trim()]], this.y + 1, 9) +
        1;
      this.doc.setTextColor(...COLORS.muted);
    }

    for (const item of block.items) {
      this.drawItemCard(item);
    }

    this.y += 3;
  }

  private drawItemCard(item: InicioManualItem): void {
    this.ensureTableFits(28);

    const body: string[][] = [[item.detail]];
    const hasExample = Boolean(item.example?.trim());
    if (hasExample) {
      body.push([`Ejemplo: ${item.example!.trim()}`]);
    }

    this.autoTable(this.doc, {
      startY: this.y,
      margin: this.tableMargin(),
      theme: 'grid',
      head: [[pdfSafe(item.term)]],
      body: body.map((row) => row.map(pdfSafe)),
      headStyles: {
        fillColor: COLORS.primary,
        textColor: COLORS.white,
        fontStyle: 'bold',
        fontSize: 10,
        cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
      },
      bodyStyles: {
        font: 'helvetica',
        fontSize: 9.5,
        cellPadding: 4,
        overflow: 'linebreak',
        cellWidth: this.contentW,
        valign: 'top',
        textColor: COLORS.text,
        fillColor: COLORS.cardBg,
        lineColor: COLORS.border,
        lineWidth: 0.15,
      },
      didParseCell: (data: { section: string; row: { index: number }; cell: { styles: Record<string, unknown> } }) => {
        if (data.section === 'body' && hasExample && data.row.index === 1) {
          data.cell.styles['fillColor'] = COLORS.exampleBg;
          data.cell.styles['fontSize'] = 9;
        }
      },
    });

    this.y = lastTableY(this.doc) + 4;
  }
}

/** Genera y descarga el manual de un equipo (PR500 / PRO400 / PRO300). */
export async function downloadInicioManualPdf(manual: InicioDeviceManual): Promise<void> {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const renderer = new ManualPdfRenderer(doc, manual, autoTable as AutoTableFn);
  renderer.render();

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = manual.id === 'pr500' ? 'PR500' : manual.id === 'pro400' ? 'PRO400' : 'PRO300';
  doc.save(`manual-${slug}-SG-${stamp}.pdf`);
}
