-- Reset de notificaciones push (admin).
-- Usar cuando cambiaste el par VAPID o hay suscripciones viejas que impiden reactivar.
--
-- NO borra usuarios ni contraseñas. Solo vacía push_subscriptions.
-- Cada usuario debe volver a: Comunidad → Activar tono y notificaciones (FCM).
--
-- Ejecutar en Supabase → SQL Editor (una sola vez).

-- Opcional: ver cuántas filas hay antes de borrar
select count(*) as dispositivos_registrados,
       count(distinct user_id) as usuarios_con_push
from public.push_subscriptions;

-- Borrar TODAS las suscripciones push
delete from public.push_subscriptions;

-- Verificar que quedó vacío
select count(*) as dispositivos_restantes from public.push_subscriptions;

notify pgrst, 'reload schema';
