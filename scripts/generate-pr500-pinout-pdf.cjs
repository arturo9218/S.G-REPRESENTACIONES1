/**
 * Genera docs/PR500_PCB_PINOUT_STAGE3.pdf desde docs/PR500_PCB_PINOUT_STAGE3.md
 * Paginación línea a línea para que no se corte contenido al final de página.
 * Uso: node scripts/generate-pr500-pinout-pdf.cjs
 */
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');

const root = path.join(__dirname, '..');
const mdPath = path.join(root, 'docs', 'PR500_PCB_PINOUT_STAGE3.md');
const outPath = path.join(root, 'docs', 'PR500_PCB_PINOUT_STAGE3.pdf');

function stripInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function parseMd(md) {
  const raw = md.replace(/\r\n/g, '\n');
  const out = [];
  let inFence = false;
  for (let line of raw.split('\n')) {
    const t = line.trimEnd();
    if (t.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push({ type: 'mono', text: t });
      continue;
    }
    if (t === '---') continue;
    if (!t.trim()) {
      out.push({ type: 'blank' });
      continue;
    }
    if (t.startsWith('# ')) {
      out.push({ type: 'h1', text: stripInline(t.slice(2)) });
      continue;
    }
    if (t.startsWith('## ')) {
      out.push({ type: 'h2', text: stripInline(t.slice(3)) });
      continue;
    }
    if (t.startsWith('### ')) {
      out.push({ type: 'h3', text: stripInline(t.slice(4)) });
      continue;
    }
    if (t.startsWith('|') && t.includes('|')) {
      if (/^\|[\s\-:|]+\|?\s*$/.test(t)) continue;
      const cells = t
        .split('|')
        .map((c) => stripInline(c.trim()))
        .filter((c) => c.length > 0);
      if (cells.length) out.push({ type: 'table', text: cells.join(' — ') });
      continue;
    }
    if (t.startsWith('- ')) {
      out.push({ type: 'bullet', text: stripInline(t.slice(2)) });
      continue;
    }
    const num = t.match(/^(\d+)\.\s+(.*)$/);
    if (num) {
      out.push({ type: 'num', n: num[1], text: stripInline(num[2]) });
      continue;
    }
    out.push({ type: 'p', text: stripInline(t) });
  }
  return out;
}

function main() {
  if (!fs.existsSync(mdPath)) {
    console.error('No existe:', mdPath);
    process.exit(1);
  }
  const md = fs.readFileSync(mdPath, 'utf8');
  const blocks = parseMd(md);

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;
  const bottomMargin = 12;
  const maxW = pageW - 2 * margin;
  const maxY = pageH - bottomMargin;
  let y = margin;
  let pageNum = 1;

  const bodySize = 9;
  const h1Size = 14;
  const h2Size = 12;
  const h3Size = 11;
  const monoSize = 7.5;

  function lineHeightMm(fontSize) {
    return Math.max(4.2, fontSize * 0.42);
  }

  function newPage() {
    doc.addPage();
    pageNum += 1;
    y = margin;
  }

  function footer() {
    const t = `PR500 PCB / GPIO — ${pageNum}`;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 100, 100);
    doc.text(t, pageW / 2, pageH - 6, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }

  function drawLineByLine(lines, fontSize, fontStyle, lineMm, indent = 0) {
    doc.setFontSize(fontSize);
    doc.setFont('helvetica', fontStyle);
    const x = margin + indent;
    for (const line of lines) {
      if (y + lineMm > maxY) {
        footer();
        newPage();
      }
      doc.text(line, x, y);
      y += lineMm;
    }
  }

  function drawMonoLine(line, lineMm) {
    doc.setFontSize(monoSize);
    doc.setFont('courier', 'normal');
    const wrapped = doc.splitTextToSize(line, maxW - 2);
    for (const w of wrapped) {
      if (y + lineMm > maxY) {
        footer();
        newPage();
      }
      doc.text(w, margin + 2, y);
      y += lineMm;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(bodySize);
  }

  for (const b of blocks) {
    if (b.type === 'blank') {
      y += lineHeightMm(bodySize) * 0.4;
      continue;
    }
    if (b.type === 'h1') {
      doc.setFontSize(h1Size);
      doc.setFont('helvetica', 'bold');
      const lh = lineHeightMm(h1Size);
      const lines = doc.splitTextToSize(b.text, maxW);
      drawLineByLine(lines, h1Size, 'bold', lh * 1.05);
      y += 2;
      continue;
    }
    if (b.type === 'h2') {
      doc.setFontSize(h2Size);
      doc.setFont('helvetica', 'bold');
      const lh = lineHeightMm(h2Size);
      const lines = doc.splitTextToSize(b.text, maxW);
      drawLineByLine(lines, h2Size, 'bold', lh * 1.02);
      y += 1.5;
      continue;
    }
    if (b.type === 'h3') {
      doc.setFontSize(h3Size);
      doc.setFont('helvetica', 'bold');
      const lh = lineHeightMm(h3Size);
      const lines = doc.splitTextToSize(b.text, maxW);
      drawLineByLine(lines, h3Size, 'bold', lh);
      y += 1;
      continue;
    }
    if (b.type === 'mono') {
      const lh = lineHeightMm(monoSize);
      drawMonoLine(b.text || ' ', lh);
      continue;
    }

    doc.setFontSize(bodySize);
    doc.setFont('helvetica', 'normal');
    let prefix = '';
    if (b.type === 'bullet') prefix = '• ';
    if (b.type === 'num') prefix = `${b.n}. `;
    const style = b.type === 'table' ? 'italic' : 'normal';
    doc.setFont('helvetica', style);
    const text = prefix + (b.text || '');
    const lh = lineHeightMm(bodySize);
    const lines = doc.splitTextToSize(text, maxW);
    drawLineByLine(lines, bodySize, style, lh, b.type === 'bullet' || b.type === 'num' ? 2 : 0);
    doc.setFont('helvetica', 'normal');
  }

  footer();
  doc.save(outPath);
  console.log('Generado:', outPath, `(${pageNum} pág.)`);
}

main();
