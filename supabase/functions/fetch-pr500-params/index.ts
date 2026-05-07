// Supabase Edge Function: fetch-pr500-params
// El ESP32 (o cualquier cliente) obtiene params F01–F28 (JSON en columna params) con module_id + deviceToken (como ingest-reading).
// Deploy: supabase functions deploy fetch-pr500-params --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body {
  moduleId?: string;
  deviceToken?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Usar POST con JSON moduleId y deviceToken' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const raw = (await req.json()) as Body;
    const moduleId = typeof raw.moduleId === 'string' ? raw.moduleId.trim() : '';
    const deviceToken = typeof raw.deviceToken === 'string' ? raw.deviceToken.trim() : '';
    if (!moduleId || !deviceToken) {
      return new Response(JSON.stringify({ error: 'Faltan moduleId o deviceToken' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Faltan variables SUPABASE_URL/SERVICE_ROLE_KEY' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(url, serviceKey);
    const { data: row, error } = await supabase
      .from('pr500_controllers')
      .select('params, updated_at, device_token_hash')
      .eq('module_id', moduleId)
      .maybeSingle();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!row || row.device_token_hash !== deviceToken) {
      return new Response(JSON.stringify({ error: 'No autorizado o PR500 no encontrado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const params =
      row.params != null && typeof row.params === 'object' && !Array.isArray(row.params)
        ? (row.params as Record<string, unknown>)
        : {};
    const updatedAt =
      typeof row.updated_at === 'string' && row.updated_at.trim()
        ? row.updated_at.trim()
        : new Date().toISOString();

    return new Response(JSON.stringify({ ok: true, updated_at: updatedAt, params }), {
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
