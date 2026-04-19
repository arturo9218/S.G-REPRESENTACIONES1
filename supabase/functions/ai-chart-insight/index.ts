// Supabase Edge Function: resumen del gráfico con IA (OpenAI).
//
// Secretos (Dashboard → Edge Functions → Secrets, o CLI):
//   supabase secrets set OPENAI_API_KEY=sk-...
//
// (Más adelante se puede volver a agregar otros proveedores — Gemini, Groq, etc. — en este mismo archivo.)
//
// Deploy:
//   supabase functions deploy ai-chart-insight
//
// Modelo por defecto: gpt-4o-mini (económico). Opcional:
//   supabase secrets set OPENAI_MODEL=gpt-4o-mini
// Timeout llamada OpenAI (ms), por defecto 22000. Opcional:
//   supabase secrets set OPENAI_TIMEOUT_MS=25000

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface InsightBody {
  deviceId?: string;
  deviceName?: string;
  rangeLabel?: string;
  statsBlock?: string;
  question?: string;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… [truncado]`;
}

type OaErr = { message?: string; type?: string; code?: string };
type OaJson = { error?: OaErr; choices?: Array<{ message?: { content?: string } }> };

function openAiErrorResponse(oaRes: Response, oaJson: OaJson, oaText: string): Response {
  const errObj = oaJson.error;
  const msg = errObj?.message ?? (oaText.trim() || `OpenAI HTTP ${oaRes.status}`);
  const code = typeof errObj?.code === 'string' ? errObj.code : '';
  const typ = typeof errObj?.type === 'string' ? errObj.type : '';
  const low = msg.toLowerCase();
  console.warn('[ai-chart-insight] OpenAI:', oaRes.status, typ, code, msg);

  const quotaish =
    code === 'insufficient_quota' ||
    typ === 'insufficient_quota' ||
    low.includes('quota') ||
    low.includes('billing') ||
    low.includes('exceeded your current');

  let status: number;
  let errBody: string;

  if (quotaish) {
    status = 429;
    errBody = [
      'OpenAI rechazó la petición: la API key no tiene saldo o la cuota del plan está agotada.',
      'Revisá facturación y créditos en https://platform.openai.com/account/billing',
      'El secreto OPENAI_API_KEY en Supabase (Edge Functions → Secrets) tiene que ser de esa misma cuenta.',
      '',
      `Detalle: ${msg}`,
    ].join('\n');
  } else if (oaRes.status === 401 || low.includes('invalid api key') || low.includes('incorrect api key')) {
    status = 401;
    errBody = [
      'OpenAI rechazó la API key (inválida o revocada).',
      'Revisá OPENAI_API_KEY en Supabase → Edge Functions → Secrets.',
      '',
      `Detalle: ${msg}`,
    ].join('\n');
  } else if (oaRes.status === 429) {
    status = 429;
    errBody = [
      'OpenAI aplicó límite de velocidad (rate limit). Esperá unos segundos y reintentá.',
      '',
      `Detalle: ${msg}`,
    ].join('\n');
  } else if (oaRes.status === 503 || oaRes.status === 529) {
    status = 503;
    errBody = ['OpenAI no está disponible temporalmente. Probá en unos minutos.', '', `Detalle: ${msg}`].join('\n');
  } else {
    errBody = `IA: ${msg}`;
    status = oaRes.status >= 400 && oaRes.status < 500 ? oaRes.status : 502;
  }

  return new Response(JSON.stringify({ error: errBody }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const openaiKey = Deno.env.get('OPENAI_API_KEY')?.trim() ?? '';
    const openaiModel = Deno.env.get('OPENAI_MODEL')?.trim() || 'gpt-4o-mini';

    if (!url || !anonKey || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Faltan variables de Supabase en la función.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!openaiKey) {
      return new Response(
        JSON.stringify({
          error:
            'OPENAI_API_KEY no está configurada. En Supabase: Edge Functions → Secrets → agregar OPENAI_API_KEY.',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseUser = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabaseUser.auth.getUser();

    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Sesión inválida o vencida. Iniciá sesión de nuevo.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body: InsightBody;
    try {
      body = (await req.json()) as InsightBody;
    } catch {
      return new Response(JSON.stringify({ error: 'JSON inválido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!deviceId || !UUID_RE.test(deviceId)) {
      return new Response(JSON.stringify({ error: 'deviceId UUID inválido.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(url, serviceKey);

    /** Misma idea que RLS + get_device_readings_chart: admin de app ve cualquier equipo. */
    const emailNorm = (user.email ?? '').trim().toLowerCase();
    let isAppAdmin = false;
    if (emailNorm) {
      const { data: admRow, error: admErr } = await admin
        .from('admin_emails')
        .select('email')
        .eq('email', emailNorm)
        .maybeSingle();
      if (admErr) {
        console.warn('[ai-chart-insight] admin_emails:', admErr.message);
      } else if (admRow?.email) {
        isAppAdmin = true;
      }
    }

    let devQ = admin.from('devices').select('id, name').eq('id', deviceId);
    if (!isAppAdmin) {
      devQ = devQ.eq('owner_user_id', user.id);
    }
    const { data: device, error: devErr } = await devQ.maybeSingle();

    if (devErr || !device) {
      return new Response(JSON.stringify({ error: 'No tenés acceso a este equipo o no existe.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const deviceName =
      typeof body.deviceName === 'string' && body.deviceName.trim()
        ? body.deviceName.trim()
        : typeof device.name === 'string'
          ? device.name
          : 'Equipo';

    const rangeLabel = clip(typeof body.rangeLabel === 'string' ? body.rangeLabel : '', 800);
    /** Menos texto = respuesta de OpenAI más rápida (evita 504 del gateway de Supabase). */
    const statsBlock = clip(typeof body.statsBlock === 'string' ? body.statsBlock : '', 3500);
    const question = clip(typeof body.question === 'string' ? body.question : '', 500);

    if (!statsBlock) {
      return new Response(JSON.stringify({ error: 'Falta información de resumen (statsBlock).' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const system = `Sos un asistente técnico para instalaciones de frío y monitoreo de temperatura/corriente.
Reglas:
- Respondé en español rioplatense, tono profesional y claro.
- Usá SOLO los datos que te pasan en el contexto; no inventes números ni lecturas.
- Si los datos no alcanzan, decilo y sugerí qué revisar en campo o en el gráfico.
- No reemplazás el criterio de un técnico matriculado: aclará que es orientación general.
- Sé breve salvo que pidan detalle: máximo unas pocas viñetas o un párrafo corto más lista si aplica.`;

    const userMsg = [
      `Equipo: ${deviceName} (id ${deviceId})`,
      rangeLabel ? `Rango temporal: ${rangeLabel}` : '',
      '--- Datos agregados (puede haber promedios por hora/día si el rango es largo) ---',
      statsBlock,
      question ? `--- Pregunta del usuario ---\n${question}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const openAiTimeoutMs = Number(Deno.env.get('OPENAI_TIMEOUT_MS') ?? '22000');

    let oaRes: Response;
    try {
      oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: openaiModel,
          temperature: 0.35,
          max_tokens: 520,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMsg },
          ],
        }),
        signal: AbortSignal.timeout(Math.min(60_000, Math.max(12_000, openAiTimeoutMs))),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout =
        (e instanceof Error && e.name === 'TimeoutError') ||
        /aborted|timeout|signal/i.test(msg);
      return new Response(
        JSON.stringify({
          error: isTimeout
            ? 'OpenAI tardó demasiado (timeout). Probá de nuevo en un minuto o acortá el rango del gráfico. No tiene que ver con usar localhost.'
            : `Fallo al llamar a OpenAI: ${msg}`,
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const oaText = await oaRes.text();
    let oaJson: OaJson = {};
    try {
      oaJson = oaText ? (JSON.parse(oaText) as OaJson) : {};
    } catch {
      console.warn('[ai-chart-insight] OpenAI body no JSON:', oaText.slice(0, 240));
    }

    if (!oaRes.ok) {
      return openAiErrorResponse(oaRes, oaJson, oaText);
    }

    const insight = oaJson.choices?.[0]?.message?.content?.trim() ?? '';
    if (!insight) {
      return new Response(JSON.stringify({ error: 'La IA no devolvió texto.' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ insight }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ai-chart-insight]', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
