import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  readonly client: SupabaseClient;

  constructor() {
    if (typeof window !== 'undefined' && window.sessionStorage && window.localStorage) {
      // Migración suave: antes usábamos sessionStorage, ahora localStorage para compartir sesión
      // entre pestañas (dashboard -> análisis). Si existe token viejo, lo copiamos.
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (!k) continue;
          const looksLikeSupabaseToken =
            k.includes('-auth-token') && k.startsWith('sb-');
          if (!looksLikeSupabaseToken) continue;
          if (!window.localStorage.getItem(k)) {
            const v = window.sessionStorage.getItem(k);
            if (v) window.localStorage.setItem(k, v);
          }
        }
      } catch {
        // no-op
      }
    }

    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : typeof window !== 'undefined' && window.sessionStorage
        ? window.sessionStorage
        : undefined;

    this.client = createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
        // localStorage => comparte sesión entre pestañas (dashboard -> analysis).
        storage,
      },
    });
  }
}
