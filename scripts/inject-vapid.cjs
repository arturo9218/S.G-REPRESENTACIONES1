/**
 * Antes del build, escribe la clave pública VAPID desde la variable de entorno VAPID_PUBLIC_KEY.
 * En el hosting (p. ej. variables de entorno del proyecto): VAPID_PUBLIC_KEY (solo la clave pública).
 */
const fs = require('fs');
const path = require('path');

const key = process.env.VAPID_PUBLIC_KEY?.trim() ?? '';
const target = path.join(__dirname, '..', 'src', 'environments', 'vapid.inject.ts');
const content = `/* Generado por scripts/inject-vapid.cjs — no editar */
export const VAPID_INJECT = ${JSON.stringify(key)};
`;

fs.writeFileSync(target, content, 'utf8');
if (key) {
  console.log('[inject-vapid] VAPID_PUBLIC_KEY aplicada al build.');
} else {
  console.warn(
    '[inject-vapid] VAPID_PUBLIC_KEY no está definida; Web Push quedará desactivado hasta configurarla en el entorno del build (hosting o local).'
  );
}
