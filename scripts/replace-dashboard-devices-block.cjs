const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '../src/app/dashboard/dashboard.component.html');
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.includes('class="grid-main__left"') && l.includes("shellRoute === 'devices'"));
if (start < 0) throw new Error('grid-main__left block not found');
let end = start;
let depth = 0;
for (let i = start; i < lines.length; i++) {
  const open = (lines[i].match(/<div\b/g) || []).length;
  const close = (lines[i].match(/<\/div>/g) || []).length;
  if (i === start) depth = 1;
  else depth += open - close;
  if (depth === 0) {
    end = i;
    break;
  }
}
const replacement = "        <app-devices-page *ngIf=\"shellRoute === 'devices'\"></app-devices-page>";
const out = [...lines.slice(0, start), replacement, ...lines.slice(end + 1)].join('\n');
fs.writeFileSync(p, out, 'utf8');
console.log(`Replaced lines ${start + 1}-${end + 1}`);
