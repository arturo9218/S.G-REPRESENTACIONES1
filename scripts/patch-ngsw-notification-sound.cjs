/**
 * El ngsw-worker de Angular solo pasa a showNotification() las claves de NOTIFICATION_OPTION_NAMES.
 * Sin "sound", Android/Chrome suele mostrar la notificación en silencio aunque el payload la traiga.
 * Este script añade "sound" de forma idempotente (tras cada npm install).
 */
const fs = require('fs');
const path = require('path');

const swPath = path.join(__dirname, '..', 'node_modules', '@angular', 'service-worker', 'ngsw-worker.js');

if (!fs.existsSync(swPath)) {
  console.warn('[patch-ngsw-notification-sound] ngsw-worker.js no encontrado, se omite.');
  process.exit(0);
}

let s = fs.readFileSync(swPath, 'utf8');
if (s.includes('\n    "sound",\n')) {
  process.exit(0);
}

const needle = '"silent",\n    "tag",';
if (!s.includes(needle)) {
  console.error(
    '[patch-ngsw-notification-sound] Patrón no encontrado (¿cambió @angular/service-worker?). Editá el script.'
  );
  process.exit(1);
}

s = s.replace(needle, '"silent",\n    "sound",\n    "tag",');
fs.writeFileSync(swPath, s);
console.log('[patch-ngsw-notification-sound] Añadido "sound" a NOTIFICATION_OPTION_NAMES.');
