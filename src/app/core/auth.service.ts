import { Injectable } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { SupabaseService } from './supabase.service';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  constructor(private readonly supabase: SupabaseService) {}

  get client() {
    return this.supabase.client;
  }

  /**
   * Respaldo offline / si falla el RPC (la fuente de verdad es public.admin_emails en Supabase).
   */
  isAdminEmail(email: string | undefined | null): boolean {
    const list = environment.adminEmails ?? [];
    if (!email || !list.length) return false;
    const n = email.trim().toLowerCase();
    return list.some((e) => e.trim().toLowerCase() === n);
  }

  /** Coincide con public.is_app_admin() (tabla admin_emails). Ante error de red usa isAdminEmail. */
  async fetchIsAppAdmin(): Promise<boolean> {
    const session = await this.getSession();
    if (!session?.user?.email) return false;
    try {
      const { data, error } = await this.client.rpc('is_app_admin');
      if (error) {
        console.warn('is_app_admin:', error.message);
        return this.isAdminEmail(session.user.email);
      }
      return data === true;
    } catch {
      return this.isAdminEmail(session.user.email);
    }
  }

  async getSession(): Promise<Session | null> {
    // En múltiples pestañas el lock de Supabase puede fallar de forma transitoria.
    // Evitamos que ese rechazo rompa el flujo de la app.
    for (let i = 0; i < 4; i++) {
      try {
        const { data } = await this.client.auth.getSession();
        return data.session ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        const lockError =
          msg.includes('LockManager') ||
          msg.includes('NavigatorLockAcquireTimeoutError') ||
          msg.includes('auth-token');
        if (!lockError) return null;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      }
    }
    return null;
  }

  async signIn(email: string, password: string) {
    // Evita mezclar sesión previa al cambiar de usuario en el mismo navegador.
    await this.client.auth.signOut();
    return this.client.auth.signInWithPassword({ email: email.trim(), password });
  }

  async signUp(email: string, password: string) {
    return this.client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/login` : undefined,
      },
    });
  }

  async signOut() {
    await this.client.auth.signOut();
  }

  resetPasswordEmailRedirectUrl(): string {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/restablecer-contrasena`;
  }

  async resetPasswordForEmail(email: string) {
    return this.client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: this.resetPasswordEmailRedirectUrl(),
    });
  }

  async updatePassword(newPassword: string) {
    return this.client.auth.updateUser({ password: newPassword });
  }
}
