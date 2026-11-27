import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';
import { isSupabaseConfigured } from './supabase-config';

export interface SupabaseHealthReport {
  ok: boolean;
  warnings: string[];
}

/**
 * Comprueba migraciones SQL críticas (solo lectura; no modifica la base).
 */
@Injectable({ providedIn: 'root' })
export class SupabaseHealthService {
  private lastReport: SupabaseHealthReport | null = null;

  constructor(private readonly auth: AuthService) {}

  get cached(): SupabaseHealthReport | null {
    return this.lastReport;
  }

  async check(): Promise<SupabaseHealthReport> {
    if (!environment.deviceCloudSync || !isSupabaseConfigured()) {
      this.lastReport = { ok: true, warnings: [] };
      return this.lastReport;
    }
    const session = await this.auth.getSession();
    if (!session?.user?.id) {
      this.lastReport = { ok: true, warnings: [] };
      return this.lastReport;
    }

    const warnings: string[] = [];

    const members = await this.auth.client.from('combistato_members').select('member_user_id').limit(1);
    if (members.error) {
      const msg = members.error.message ?? '';
      if (msg.includes('combistato_members') || msg.includes('schema cache') || msg.includes('42P01')) {
        warnings.push('Falta SQL 066_combistato_members.sql (compartir PRO300).');
      }
    } else {
      const emailCol = await this.auth.client.from('combistato_members').select('member_email').limit(1);
      if (emailCol.error?.message?.includes('member_email')) {
        warnings.push('Falta SQL 068_combistato_members_email.sql (emails de invitados PRO300).');
      }
    }

    const profiles = await this.auth.client.from('user_profiles').select('user_id').limit(1);
    if (profiles.error?.message?.includes('user_profiles') || profiles.error?.code === '42P01') {
      warnings.push('Opcional: 069_user_profiles.sql (roles cliente/técnico en registro).');
    }

    this.lastReport = { ok: warnings.length === 0, warnings };
    return this.lastReport;
  }
}
