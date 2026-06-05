# Claves VAPID (notificaciones push / FCM)

## ¿Las tengo?

### En el proyecto (código)
- Abrí `src/environments/vapid.inject.ts`
- Si dice `export const VAPID_INJECT = "";` → **no hay clave en el build** (notificaciones con app cerrada no funcionan).

### En Vercel
1. Proyecto → **Settings** → **Environment Variables**
2. Buscá `VAPID_PUBLIC_KEY`
3. Si no existe → hay que crearla y **redeploy**.

### En Supabase
1. **Project Settings** → **Edge Functions** → **Secrets**
2. Deben existir (mismo par):
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (ej. `mailto:arturo@tudominio.com`)

Si en Supabase no aparecen, **no las tenés configuradas** (las alarmas push tampoco llegarían).

## Crear un par nuevo (una sola vez)

En la carpeta `FRONTEND`, con Node instalado:

```bash
npx web-push generate-vapid-keys
```

Te muestra algo como:

```
Public Key:
BEl...larga...

Private Key:
xYz...secreta...
```

- **VAPID_PUBLIC_KEY** = la Public Key → Vercel + Supabase secret + variable de build
- **VAPID_PRIVATE_KEY** = la Private Key → **solo Supabase** (nunca en GitHub)
- **VAPID_SUBJECT** = `mailto:` + tu email real (ej. `mailto:arturo9218@gmail.com`)

Después en Vercel: guardá la variable y hacé **Redeploy**.

En Supabase: pegá los tres secrets y guardá.

## Probar

1. En la app publicada (HTTPS): Comunidad → **Activar tono y notificaciones (FCM)**
2. Debe decir: `FCM: suscrito` (no "falta VAPID")
3. En Supabase → Table Editor → `push_subscriptions` → debe haber una fila con tu `user_id`
