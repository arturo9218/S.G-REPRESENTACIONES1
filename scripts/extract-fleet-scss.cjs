/**
 * Extrae estilos de flota/dispositivos del SCSS del dashboard para devices-page.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashScss = fs.readFileSync(path.join(root, 'src/app/dashboard/dashboard.component.scss'), 'utf8');
const lines = dashScss.split(/\r?\n/);

const vars = lines.slice(0, 7).join('\n');
// Rangos con estilos usados en la vista Dispositivos (sync, chart, tarjetas, secciones)
const ranges = [
  [219, 268],
  [366, 397],
  [649, 692],
  [932, 2588],
  [3157, 3160],
  [3472, 3487],
];

const extracted = [vars, ''];
for (const [start, end] of ranges) {
  extracted.push(lines.slice(start - 1, end).join('\n'));
  extracted.push('');
}

const out = extracted.join('\n');
fs.writeFileSync(path.join(root, 'src/app/devices/dashboard-fleet.scss'), out, 'utf8');
console.log('Wrote dashboard-fleet.scss', out.length, 'chars');
