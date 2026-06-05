// Webhook de Supabase Database → push al recibir mensaje (app cerrada / segundo plano).
// Deploy: supabase functions deploy notify-chat-message --no-verify-jwt
// Secret: CHAT_PUSH_SECRET (mismo valor en header x-chat-push-secret del webhook)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPushToUser, sendPushToUsers } from '../_shared/send-web-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-chat-push-secret',
};

type WebhookBody = {
  type?: string;
  table?: string;
  record?: Record<string, unknown>;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const secret = Deno.env.get('CHAT_PUSH_SECRET')?.trim();
  const headerSecret = req.headers.get('x-chat-push-secret')?.trim();
  if (!secret || headerSecret !== secret) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Faltan variables de Supabase' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: WebhookBody;
  try {
    body = (await req.json()) as WebhookBody;
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const table = body.table;
  const record = body.record;
  if (!record || body.type !== 'INSERT') {
    return new Response(JSON.stringify({ skipped: 'not_insert' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(url, serviceKey);
  const text = String(record['body'] ?? '').trim();
  const preview = text.length > 160 ? `${text.slice(0, 157)}…` : text;

  if (table === 'private_messages') {
    const recipientId = String(record['recipient_id'] ?? '');
    const senderEmail = String(record['sender_email'] ?? 'Usuario').trim().toLowerCase();
    if (!recipientId) {
      return new Response(JSON.stringify({ skipped: 'no_recipient' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const at = senderEmail.indexOf('@');
    const who =
      at > 1 ? senderEmail.slice(0, 1).toUpperCase() + senderEmail.slice(1, at) : senderEmail;
    const result = await sendPushToUser(supabase, recipientId, {
      title: `Mensaje de ${who}`,
      body: preview || 'Nuevo mensaje privado',
      tag: `dm-${record['sender_id']}`,
      navigate: '/comunidad',
      requireInteraction: false,
    });
    return new Response(JSON.stringify({ table, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (table === 'community_messages') {
    const senderId = String(record['user_id'] ?? '');
    const authorEmail = String(record['author_email'] ?? 'Usuario').trim().toLowerCase();
    const at = authorEmail.indexOf('@');
    const who =
      at > 1 ? authorEmail.slice(0, 1).toUpperCase() + authorEmail.slice(1, at) : authorEmail;

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('user_id')
      .neq('user_id', senderId);
    if (error || !subs?.length) {
      return new Response(
        JSON.stringify({ skipped: error?.message ?? 'no_subscriptions' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const userIds = [...new Set(subs.map((s) => s.user_id as string).filter(Boolean))];
    const result = await sendPushToUsers(supabase, userIds, {
      title: `Comunidad — ${who}`,
      body: preview || 'Nuevo mensaje en la sala',
      tag: `community-${record['id'] ?? 'new'}`,
      navigate: '/comunidad',
      requireInteraction: false,
    });
    return new Response(JSON.stringify({ table, recipients: userIds.length, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ skipped: 'unknown_table' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
