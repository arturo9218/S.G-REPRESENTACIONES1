-- Push de mensajes de chat con la app cerrada (Web Push).
-- Requiere: función Edge notify-chat-message desplegada y secret CHAT_PUSH_SECRET.

-- 1) En Supabase → Project Settings → Edge Functions → Secrets:
--    CHAT_PUSH_SECRET = una clave larga (ej. openssl rand -hex 32)
--    (Ya debés tener VAPID_*, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY en la función.)

-- 2) Deploy:
--    supabase functions deploy notify-chat-message --no-verify-jwt

-- 3) Database Webhooks (Dashboard → Database → Webhooks → Create hook):
--
--    Hook A — private_messages
--      Table: public.private_messages
--      Events: Insert
--      Method: POST
--      URL: https://TU_PROYECTO.supabase.co/functions/v1/notify-chat-message
--      Headers:
--        x-chat-push-secret: <CHAT_PUSH_SECRET>
--        Content-Type: application/json
--
--    Hook B — community_messages
--      Igual con tabla public.community_messages
--
-- 4) En la app: Comunidad → "Activar tono y notificaciones"
--    (permiso del navegador + suscripción push, como las alarmas de equipos).

comment on table public.private_messages is
  'Mensajes 1 a 1; webhook INSERT → notify-chat-message para push en segundo plano.';
