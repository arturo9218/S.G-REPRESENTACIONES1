/**
 * Genera docs/MANUAL_DE_USO.pdf desde docs/MANUAL_DE_USO.md
 * Uso: node scripts/generate-manual-pdf.cjs
 */
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');

const root = path.join(__dirname, '..');
const mdPath = path.join(root, 'docs', 'MANUAL_DE_USO.md');
const outPath = path.join(root, 'docs', 'MANUAL_DE_USO.pdf');

function stripInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function parseMd(md) {
  const raw = md.replace(/\r\n/g, '\n');
  const out = [];
  for (let line of raw.split('\n')) {
    const t = line.trimEnd();
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
  const margin = 16;
  const maxW = pageW - 2 * margin;
  let y = margin;
  const lineH = 5;
  const bodySize = 10;
  const h1Size = 14;
  const h2Size = 12;
  const h3Size = 11;

  function newPage() {
    doc.addPage();
    y = margin;
  }

  function ensureSpace(h) {
    if (y + h > pageH - margin) newPage();
  }

  for (const b of blocks) {
    if (b.type === 'blank') {
      y += lineH * 0.35;
      continue;
    }
    if (b.type === 'h1') {
      ensureSpace(12);
      doc.setFontSize(h1Size);
      doc.setFont('helvetica', 'bold');
      const lines = doc.splitTextToSize(b.text, maxW);
      doc.text(lines, margin, y + 5);
      y += lines.length * 6 + 4;
      doc.setFont('helvetica', 'normal');
      continue;
    }
    if (b.type === 'h2') {
      ensureSpace(10);
      doc.setFontSize(h2Size);
      doc.setFont('helvetica', 'bold');
      const lines = doc.splitTextToSize(b.text, maxW);
      doc.text(lines, margin, y + 5);
      y += lines.length * 5.5 + 3;
      doc.setFont('helvetica', 'normal');
      continue;
    }
    if (b.type === 'h3') {
      ensureSpace(9);
      doc.setFontSize(h3Size);
      doc.setFont('helvetica', 'bold');
      const lines = doc.splitTextToSize(b.text, maxW);
      doc.text(lines, margin, y + 4.5);
      y += lines.length * 5 + 2;
      doc.setFont('helvetica', 'normal');
      continue;
    }
    doc.setFontSize(bodySize);
    doc.setFont('helvetica', 'normal');
    let prefix = '';
    if (b.type === 'bullet') prefix = '• ';
    if (b.type === 'num') prefix = `${b.n}. `;
    if (b.type === 'table') {
      doc.setFont('helvetica', 'italic');
    }
    const text = prefix + (b.text || '');
    const lines = doc.splitTextToSize(text, maxW);
    const h = lines.length * lineH + 1;
    ensureSpace(h);
    doc.text(lines, margin, y + 5);
    y += h;
    doc.setFont('helvetica', 'normal');
  }

  doc.save(outPath);
  console.log('Generado:', outPath);
}

main();
