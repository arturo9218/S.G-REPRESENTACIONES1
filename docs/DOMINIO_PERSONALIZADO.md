# Dominio propio (sin `vercel.app` en la URL)

La dirección tipo `tu-proyecto.vercel.app` la asigna Vercel por defecto. Para que los usuarios abran **tu marca** (`https://panel.tudominio.com`, etc.), hay que usar un **dominio personalizado**.

## Pasos resumidos (Vercel)

1. Comprá o usá un dominio que controlés (registrador DNS).
2. En [Vercel](https://vercel.com) → tu proyecto → **Settings** → **Domains** → **Add** e ingresá el dominio o subdominio.
3. Seguí las instrucciones de Vercel para crear los registros DNS (normalmente **CNAME** al target que indiquen, o **A** para raíz `@`).
4. Esperá la propagación DNS (minutos u horas). Cuando el estado sea “Valid”, la app cargará por la nueva URL.

La app Angular no “cambia sola” el nombre del host: el hosting y el DNS definen qué URL responde. La **URL de ingesta** (`api_url` hacia Supabase) **no depende** del dominio de la PWA; sigue siendo la de tu proyecto Supabase salvo que muevas también las Functions.

## Web Push y HTTPS

Las notificaciones push requieren **HTTPS** en el origen que el usuario visita. Un dominio propio con certificado válido (Vercel lo gestiona) cumple eso igual que `*.vercel.app`.
