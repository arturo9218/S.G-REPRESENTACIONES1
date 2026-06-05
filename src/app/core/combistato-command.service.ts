import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

/**
 * Cliente para la edge function `pro300-send-command`: manda comandos manuales
 * (forzar comp/vent, gatillar/cancelar deshielo, cancelar forzados) al PRO300.
 *
 * El servidor escribe el comando en `combistatos.pending_command` y bumpea
 * `updated_at`. El ESP hace pull cada ~20 s (o cada 5 s mientras el comando
 * sigue pendiente) sin aumentar los INSERT de telemetría (60 s + eventos).
 * Lag típico: 5–25 s.
 */
export type CombistatoCommandKind =
  | 'force_comp'
  | 'force_fan'
  | 'force_defrost'
  | 'cancel_defrost'
  | 'cancel_force';

@Injectable({ providedIn: 'root' })
export class CombistatoCommandService {
  constructor(private auth: AuthService) {}

  async send(combistatoId: string, kind: CombistatoCommandKind, value?: boolean): Promise<void> {
    if (!combistatoId) throw new Error('combistatoId requerido');
    const session = await this.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Iniciá sesión para mandar comandos al PRO300.');

    const url = `${environment.supabaseUrl.replace(/\/$/, '')}/functions/v1/pro300-send-command`;
    const body: Record<string, unknown> = { combistatoId, kind };
    if (typeof value === 'boolean') body['value'] = value;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        apikey: environment.supabaseAnonKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j?.error) detail = j.error;
      } catch {
        // ignoramos el parseo si el cuerpo no es JSON
      }
      throw new Error(detail);
    }
  }
}
