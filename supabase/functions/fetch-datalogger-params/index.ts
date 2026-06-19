// Supabase Edge Function: fetch-datalogger-params
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const KEYS = [
  'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11',
  'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23',
  'F24', 'F25', 'F26', 'F27', 'F28', 'F29', 'F30', 'F31', 'F32', 'F33', 'F34',
  'F35', 'F36', 'F37', 'F38', 'F39', 'F40', 'F41', 'F42', 'F43', 'F44', 'F45', 'F46', 'F47', 'F48',
] as const;

function sanitize(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Usar POST con moduleId y deviceToken' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const raw = (await req.json()) as { moduleId?: string; deviceToken?: string };
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
      return new Response(JSON.stringify({ error: 'Faltan variables de entorno Supabase' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(url, serviceKey);
    const { data: row, error } = await supabase
      .from('datalogger_controllers')
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
      return new Response(JSON.stringify({ error: 'No autorizado o datalogger no encontrado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rawParams =
      row.params != null && typeof row.params === 'object' && !Array.isArray(row.params)
        ? (row.params as Record<string, unknown>)
        : {};
    const params = sanitize(rawParams);
    const updatedAt =
      typeof row.updated_at === 'string' && row.updated_at.trim()
        ? row.updated_at.trim()
        : new Date().toISOString();

    return new Response(JSON.stringify({ ok: true, params, updated_at: updatedAt }), {
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
