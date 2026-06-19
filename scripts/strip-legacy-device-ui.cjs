const fs = require('fs');
const path = require('path');

function stripLegacyDeviceBlocks(filePath) {
  let t = fs.readFileSync(filePath, 'utf8');
  const chartStart = t.indexOf('id="section-chart"');
  if (chartStart < 0) {
    console.log('skip (no chart):', filePath);
    return;
  }
  const articleStart = t.lastIndexOf('<article', chartStart);
  const articleEnd = t.indexOf('</article>', chartStart);
  if (articleStart < 0 || articleEnd < 0) throw new Error('chart block not found in ' + filePath);
  t = t.slice(0, articleStart) + t.slice(articleEnd + '</article>'.length);

  const gridMarker = 'id="section-devices"';
  const gridStart = t.indexOf(gridMarker);
  if (gridStart < 0) throw new Error('devices grid not found in ' + filePath);
  const divStart = t.lastIndexOf('<div', gridStart);
  const divEnd = t.indexOf('</div>', gridStart);
  if (divStart < 0 || divEnd < 0) throw new Error('devices grid bounds in ' + filePath);
  // Cerrar el div correcto (device-grid es un solo div de primer nivel)
  let depth = 0;
  let closeAt = -1;
  for (let i = divStart; i < t.length; i++) {
    if (t.startsWith('<div', i)) depth++;
    if (t.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) {
        closeAt = i + '</div>'.length;
        break;
      }
    }
  }
  if (closeAt < 0) throw new Error('devices grid close in ' + filePath);
  t = t.slice(0, divStart) + t.slice(closeAt);
  t = t.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(filePath, t, 'utf8');
  console.log('stripped legacy blocks:', filePath);
}

const root = path.join(__dirname, '..');
stripLegacyDeviceBlocks(path.join(root, 'src/app/devices/devices-page.component.html'));
stripLegacyDeviceBlocks(path.join(root, 'src/app/devices/_chunk.html'));
