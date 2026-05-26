// Supabase Edge Function: fetch-pro300-params
// El ESP32 del PRO300 (combistato 2 sondas + control) obtiene los parámetros F01–F55
// (mapeados a AR01–AR48 en la app) con su `moduleId` + `deviceToken`.
//
// Deploy:
//   supabase functions deploy fetch-pro300-params --no-verify-jwt
//
// Espejo de `fetch-pr500-params` pero consultando la tabla `combistatos`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body {
  moduleId?: string;
  deviceToken?: string;
}

/**
 * Solo claves numéricas conocidas (F01..F55 + F52t). Reduce el tamaño del JSON
 * y evita que metadatos arbitrarios en `params` (JSONB) inflen el parseo en el
 * ESP32 (~4 KB pool de ArduinoJson en la plaqueta).
 */
const PRO300_PARAM_KEYS = [
  'F01','F02','F03','F04','F05','F06','F07','F08','F09','F10',
  'F11','F12','F13','F14','F15','F16','F17','F18','F19','F20',
  'F25','F26','F27','F28','F29','F30','F31','F32','F33','F34',
  'F35','F36','F37','F38','F39','F40','F45','F46','F47','F48',
  'F49','F50','F51','F52','F52t','F53','F54','F55',
] as const;

function sanitizePro300Params(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of PRO300_PARAM_KEYS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
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
      .from('combistatos')
      .select('params, updated_at, device_token_hash, pending_command')
      .eq('module_id', moduleId)
      .maybeSingle();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!row || row.device_token_hash !== deviceToken) {
      return new Response(JSON.stringify({ error: 'No autorizado o PRO300 no encontrado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rawParams =
      row.params != null && typeof row.params === 'object' && !Array.isArray(row.params)
        ? (row.params as Record<string, unknown>)
        : {};
    const params = sanitizePro300Params(rawParams);
    const updatedAt =
      typeof row.updated_at === 'string' && row.updated_at.trim()
        ? row.updated_at.trim()
        : new Date().toISOString();

    // Comandos manuales pendientes (escritos por pro300-send-command). Se
    // filtran si ya expiraron, para que el firmware no agarre comandos viejos
    // que quedaron por una desconexión.
    let pendingCommand: Record<string, unknown> | null = null;
    if (
      row.pending_command &&
      typeof row.pending_command === 'object' &&
      !Array.isArray(row.pending_command)
    ) {
      const cmd = row.pending_command as Record<string, unknown>;
      const expiresRaw = typeof cmd['expiresAt'] === 'string' ? cmd['expiresAt'] : '';
      const expires = expiresRaw ? Date.parse(expiresRaw) : NaN;
      if (!Number.isFinite(expires) || expires > Date.now()) {
        pendingCommand = cmd;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        updated_at: updatedAt,
        params,
        ...(pendingCommand ? { pending_command: pendingCommand } : {}),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
