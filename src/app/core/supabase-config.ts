import { environment } from '../../environments/environment';

export function isSupabaseConfigured(): boolean {
  const { supabaseUrl, supabaseAnonKey } = environment;
  return (
    supabaseUrl.startsWith('https://') &&
    !supabaseUrl.includes('TU-PROYECTO') &&
    supabaseAnonKey.length > 20 &&
    supabaseAnonKey !== 'TU_ANON_KEY' &&
    !supabaseAnonKey.includes('PEGA_TU_ANON_KEY')
  );
}

export function ingestFunctionUrl(): string {
  const base = environment.supabaseUrl.replace(/\/$/, '');
  const path =
    (environment as { ingestFunctionPath?: string }).ingestFunctionPath ??
    '/functions/v1/ingest-reading';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
