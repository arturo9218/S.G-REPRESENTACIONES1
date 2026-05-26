// Supabase Edge Function: pro300-send-command
//
// El frontend manda comandos manuales desde la card del PRO300:
//   - force_comp     { value: true|false }  → fuerza compresor 10 min.
//   - force_fan      { value: true|false }  → fuerza ventilador 10 min.
//   - force_defrost                          → dispara ciclo de deshielo.
//   - cancel_defrost                         → corta el deshielo en curso.
//   - cancel_force                           → cancela forzados activos.
//
// La función escribe `combistatos.pending_command` y bumpea `updated_at`. El
// firmware (con propagación rápida vía params_updated_at) lo recibe en el
// próximo `fetch-pro300-params` y lo aplica. Cada comando lleva `ts` único
// para que el ESP32 no lo reaplique en pulls sucesivos.
//
// Deploy:
//   supabase functions deploy pro300-send-command
//   (NO desactivar JWT — exige usuario autenticado)
//
// Cualquier usuario logueado puede mandar comandos (lo pidió el dueño).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface Body {
  combistatoId?: string;
  kind?: string;
  value?: boolean;
}

const ALLOWED_KINDS = new Set([
  'force_comp',
  'force_fan',
  'force_defrost',
  'cancel_defrost',
  'cancel_force',
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Usar POST con JSON {combistatoId, kind, value?}' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return new Response(JSON.stringify({ error: 'Falta Authorization Bearer (usuario no autenticado)' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !serviceKey || !anonKey) {
      return new Response(JSON.stringify({ error: 'Faltan variables SUPABASE_URL/SERVICE_ROLE_KEY/ANON_KEY' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validar la sesión del usuario contra Supabase Auth.
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: 'JWT inválido o expirado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = (await req.json()) as Body;
    const combistatoId = typeof body.combistatoId === 'string' ? body.combistatoId.trim() : '';
    const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
    if (!combistatoId || !kind) {
      return new Response(JSON.stringify({ error: 'Faltan combistatoId o kind' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return new Response(JSON.stringify({ error: `kind inválido: ${kind}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Para los `force_*` con relés exigimos value boolean. Los `cancel_*` no.
    let value: boolean | null = null;
    if (kind === 'force_comp' || kind === 'force_fan') {
      if (typeof body.value !== 'boolean') {
        return new Response(JSON.stringify({ error: 'force_comp/force_fan requiere value boolean' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      value = body.value;
    }

    const admin = createClient(url, serviceKey);
    const now = new Date();
    // Le damos al firmware 90 s de ventana para agarrarlo. Si en ese lapso no
    // pulla, asumimos que se perdió o que el equipo está offline y la app
    // permitirá reintentarlo. El firmware ignora cualquier comando con
    // `expiresAt` ya pasado.
    const expires = new Date(now.getTime() + 90_000);
    const command = {
      kind,
      value,
      ts: now.toISOString(),
      expiresAt: expires.toISOString(),
      userId: userData.user.id,
    };

    const { error: updErr } = await admin
      .from('combistatos')
      .update({ pending_command: command, updated_at: now.toISOString() })
      .eq('id', combistatoId);
    if (updErr) {
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, command }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
