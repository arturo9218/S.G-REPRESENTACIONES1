// Supabase Edge Function: ingest-reading
// Recibe telemetría de ESP8266 y guarda en device_readings.
// Deploy:
// supabase functions deploy ingest-reading --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface IngestPayload {
  moduleId: string;
  deviceToken: string;
  sentAt?: string;
  temp1_c: number;
  temp2_c?: number | null;
  temp3_c?: number | null;
  power_w?: number | null;
  press1_bar?: number | null;
  press2_bar?: number | null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const raw = (await req.json()) as IngestPayload;
    const moduleId = typeof raw.moduleId === 'string' ? raw.moduleId.trim() : '';
    const deviceToken =
      typeof raw.deviceToken === 'string' ? raw.deviceToken.trim() : '';
    const payload: IngestPayload = {
      ...raw,
      moduleId,
      deviceToken,
    };

    if (!moduleId || !deviceToken || Number.isNaN(payload.temp1_c)) {
      return new Response(JSON.stringify({ error: 'Payload inválido' }), {
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

    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('id, device_token_hash, active')
      .eq('module_id', moduleId)
      .single();

    if (devErr || !device) {
      return new Response(JSON.stringify({ error: 'Dispositivo no encontrado' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!device.active) {
      return new Response(JSON.stringify({ error: 'Dispositivo inactivo' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // En producción, comparar hash seguro (bcrypt/argon) y no texto plano.
    if (device.device_token_hash !== deviceToken) {
      return new Response(JSON.stringify({ error: 'Token inválido' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { error: insErr } = await supabase.from('device_readings').insert({
      device_id: device.id,
      created_at: payload.sentAt ?? new Date().toISOString(),
      temp1_c: payload.temp1_c,
      temp2_c: payload.temp2_c ?? null,
      temp3_c: payload.temp3_c ?? null,
      power_w: payload.power_w ?? null,
      press1_bar: payload.press1_bar ?? null,
      press2_bar: payload.press2_bar ?? null,
    });

    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
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
