import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  CombistatoFormModel,
  combistatoToJsonBlob,
  mergeCombistatoParams,
} from '../combistato/combistato-params.defaults';
import { AuthService } from './auth.service';
import { DashboardCombistato } from './models/dashboard.models';
import { ingestFunctionUrl, isSupabaseConfigured } from './supabase-config';

const TOKEN_MAP_PREFIX = 'ar-monitor-combistato-tokens-v1';

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export type AddCombistatoResult =
  | {
      ok: true;
      id: string;
      credentials: { moduleId: string; deviceToken: string; ingestUrl: string };
    }
  | { ok: false; error: string };

@Injectable({
  providedIn: 'root',
})
export class CombistatoStoreService {
  private userScopeKey = 'anon';
  private readonly subject = new BehaviorSubject<DashboardCombistato[]>([]);
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  readonly combistatos$ = this.subject.asObservable();

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {
    void this.hydrateFromCloud();
    this.auth.client.auth.onAuthStateChange((_event, session) => {
      this.userScopeKey = session?.user?.id ?? 'anon';
      if (!session?.user?.id) {
        this.clearCombistatoPoll();
      }
      this.zone.run(() => void this.hydrateFromCloud());
    });
  }

  get snapshot(): DashboardCombistato[] {
    return this.subject.value;
  }

  private cloudEnabled(): boolean {
    return environment.deviceCloudSync === true && isSupabaseConfigured();
  }

  getIngestUrl(): string {
    return ingestFunctionUrl();
  }

  private randomHex(byteLen: number): string {
    const arr = new Uint8Array(byteLen);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  private randomModuleId(): string {
    return `CMB-${this.randomHex(4)}`;
  }

  private randomSixDigitToken(): string {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    let s = '';
    for (let i = 0; i < 6; i++) s += String(a[i] % 10);
    return s;
  }

  private tokensStorageKey(): string {
    return `${TOKEN_MAP_PREFIX}:${this.userScopeKey}`;
  }

  private readTokenMap(): Record<string, string> {
    try {
      const raw = localStorage.getItem(this.tokensStorageKey());
      if (!raw) return {};
      const o = JSON.parse(raw) as unknown;
      if (!o || typeof o !== 'object') return {};
      return o as Record<string, string>;
    } catch {
      return {};
    }
  }

  private saveToken(combistatoId: string, token: string): void {
    const m = this.readTokenMap();
    m[combistatoId] = token;
    localStorage.setItem(this.tokensStorageKey(), JSON.stringify(m));
  }

  private removeToken(combistatoId: string): void {
    const m = this.readTokenMap();
    delete m[combistatoId];
    localStorage.setItem(this.tokensStorageKey(), JSON.stringify(m));
  }

  private async moduleExistsInCloud(moduleId: string): Promise<boolean> {
    const { data } = await this.auth.client
      .from('combistatos')
      .select('id')
      .eq('module_id', moduleId)
      .maybeSingle();
    return data != null;
  }

  private async tokenInUseInCloud(token: string): Promise<boolean> {
    const { data } = await this.auth.client
      .from('combistatos')
      .select('id')
      .eq('device_token_hash', token)
      .maybeSingle();
    return data != null;
  }

  private async randomCombistatoTokenAsync(): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const t = this.randomSixDigitToken();
      if (!(await this.tokenInUseInCloud(t))) return t;
    }
    return this.randomSixDigitToken();
  }

  private formatUpdatedLabel(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '—';
    }
  }

  private clearCombistatoPoll(): void {
    if (this.pollHandle != null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private ensureCombistatoPoll(): void {
    if (this.pollHandle != null) return;
    if (!this.cloudEnabled() || this.userScopeKey === 'anon') return;
    const pollMs =
      typeof environment.readingsPollIntervalMs === 'number' &&
      environment.readingsPollIntervalMs >= 2000
        ? environment.readingsPollIntervalMs
        : 4000;
    this.pollHandle = setInterval(() => {
      void this.hydrateFromCloud();
    }, pollMs);
  }

  private combistatoOnlineFromLastSeen(lastSeenIso: string | null | undefined): boolean {
    if (!lastSeenIso || typeof lastSeenIso !== 'string') return false;
    const atMs = new Date(lastSeenIso).getTime();
    if (!Number.isFinite(atMs)) return false;
    const offlineAfterMs =
      typeof environment.deviceOfflineAfterMs === 'number' && environment.deviceOfflineAfterMs > 0
        ? environment.deviceOfflineAfterMs
        : 90000;
    return Date.now() - atMs <= offlineAfterMs;
  }

  async hydrateFromCloud(): Promise<void> {
    if (!this.cloudEnabled()) {
      this.clearCombistatoPoll();
      this.subject.next([]);
      return;
    }
    const session = await this.auth.getSession();
    if (!session?.user.id) {
      this.clearCombistatoPoll();
      this.subject.next([]);
      return;
    }
    const isAdmin = await this.auth.fetchIsAppAdmin();
    this.userScopeKey = session.user.id;
    const base =
      'id, owner_user_id, module_id, name, location, device_token_hash, updated_at, last_seen_at';

    type Row = {
      id: string;
      owner_user_id: string;
      module_id: string | null;
      name: string;
      location: string | null;
      device_token_hash: string | null;
      updated_at: string;
      last_seen_at?: string | null;
    };

    let rows: Row[] = [];
    if (isAdmin) {
      const { data, error } = await this.auth.client
        .from('combistatos')
        .select(base)
        .order('name', { ascending: true });
      if (error) {
        console.warn('Supabase combistatos:', error.message);
        this.subject.next([]);
        return;
      }
      rows = (data ?? []) as Row[];
    } else {
      const { data, error } = await this.auth.client
        .from('combistatos')
        .select(base)
        .eq('owner_user_id', session.user.id)
        .order('name', { ascending: true });
      if (error) {
        if (error.message?.includes('Could not find the table') || error.code === '42P01') {
          this.subject.next([]);
          return;
        }
        console.warn('Supabase combistatos:', error.message);
        this.subject.next([]);
        return;
      }
      rows = (data ?? []) as Row[];
    }

    const tokens = this.readTokenMap();
    const mapped: DashboardCombistato[] = rows.map((r) => {
      const lastSeenRaw = r.last_seen_at;
      const lastSeenStr =
        lastSeenRaw && typeof lastSeenRaw === 'string' && lastSeenRaw.trim() ? lastSeenRaw.trim() : null;
      return {
        id: r.id,
        name: r.name,
        location: (r.location ?? '').trim() || 'Sin ubicación',
        moduleId: (r.module_id ?? '').trim() || undefined,
        updatedAtLabel: this.formatUpdatedLabel(r.updated_at),
        lastSeenLabel: lastSeenStr ? this.formatUpdatedLabel(lastSeenStr) : 'Sin contacto aún',
        online: this.combistatoOnlineFromLastSeen(lastSeenStr),
        ownerUserId: r.owner_user_id,
        deviceToken: tokens[r.id] ?? ((r.device_token_hash ?? '').trim() || undefined),
      };
    });
    for (const c of mapped) {
      if (c.deviceToken) this.saveToken(c.id, c.deviceToken);
    }
    this.subject.next(mapped);
    this.ensureCombistatoPoll();
  }

  async addCombistatoFromFormAsync(input: {
    name: string;
    location: string;
    moduleId: string;
  }): Promise<AddCombistatoResult> {
    const name = input.name.trim();
    const location = input.location.trim() || 'Sin ubicación';
    let moduleId = input.moduleId.trim();
    if (name.length < 2) {
      return { ok: false, error: 'El nombre debe tener al menos 2 caracteres.' };
    }
    const session = await this.auth.getSession();
    if (!this.cloudEnabled() || !session?.user.id) {
      return { ok: false, error: 'Iniciá sesión con nube activa para crear combistatos.' };
    }
    if (!moduleId) {
      moduleId = this.randomModuleId();
      let tries = 0;
      while ((await this.moduleExistsInCloud(moduleId)) && tries < 8) {
        moduleId = this.randomModuleId();
        tries += 1;
      }
      if (await this.moduleExistsInCloud(moduleId)) {
        return { ok: false, error: 'No se pudo generar un ID módulo único. Intentá de nuevo.' };
      }
    } else if (await this.moduleExistsInCloud(moduleId)) {
      return { ok: false, error: 'Ese ID módulo ya existe. Elegí otro o dejalo vacío para generarlo.' };
    }
    const deviceToken = await this.randomCombistatoTokenAsync();
    const defaultParams = combistatoToJsonBlob(mergeCombistatoParams(null));
    const { data, error } = await this.auth.client
      .from('combistatos')
      .insert({
        owner_user_id: session.user.id,
        module_id: moduleId,
        name,
        location,
        device_token_hash: deviceToken,
        params: defaultParams,
      })
      .select('id')
      .single();
    if (error || !data) {
      const msg = error?.message ?? 'No se pudo crear el combistato';
      if (msg.includes('Could not find the table') || error?.code === '42P01') {
        return {
          ok: false,
          error:
            'Falta la tabla en Supabase. Ejecutá FRONTEND/supabase/sql/033_combistatos.sql en el SQL Editor.',
        };
      }
      return { ok: false, error: msg };
    }
    const id = data.id as string;
    this.saveToken(id, deviceToken);
    await this.hydrateFromCloud();
    return {
      ok: true,
      id,
      credentials: {
        moduleId,
        deviceToken,
        ingestUrl: this.getIngestUrl(),
      },
    };
  }

  async updateCombistatoMeta(
    id: string,
    patch: { name: string; location: string; moduleId: string }
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { ok: false, error: 'Identificador inválido o sin nube.' };
    }
    const name = patch.name.trim();
    const location = patch.location.trim() || 'Sin ubicación';
    const moduleId = patch.moduleId.trim();
    if (name.length < 2) {
      return { ok: false, error: 'El nombre debe tener al menos 2 caracteres.' };
    }
    if (!moduleId) {
      return { ok: false, error: 'El ID módulo no puede quedar vacío.' };
    }
    const current = this.snapshot.find((c) => c.id === id);
    if (current?.moduleId !== moduleId && (await this.moduleExistsInCloud(moduleId))) {
      return { ok: false, error: 'Ese ID módulo ya está usado por otro combistato.' };
    }
    const nowIso = new Date().toISOString();
    const { error } = await this.auth.client
      .from('combistatos')
      .update({ name, location, module_id: moduleId, updated_at: nowIso })
      .eq('id', id);
    if (error) {
      return { ok: false, error: error.message };
    }
    await this.hydrateFromCloud();
    return { ok: true };
  }

  async removeCombistatoAsync(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { ok: false, error: 'Identificador inválido o sin nube.' };
    }
    const { error } = await this.auth.client.from('combistatos').delete().eq('id', id);
    if (error) {
      return { ok: false, error: error.message };
    }
    this.removeToken(id);
    await this.hydrateFromCloud();
    return { ok: true };
  }

  async fetchCombistatoParams(
    combistatoId: string
  ): Promise<{ params: CombistatoFormModel; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(combistatoId)) {
      return { params: mergeCombistatoParams(null) };
    }
    const { data, error } = await this.auth.client
      .from('combistatos')
      .select('params')
      .eq('id', combistatoId)
      .maybeSingle();
    if (error) {
      return { params: mergeCombistatoParams(null), error: error.message };
    }
    return { params: mergeCombistatoParams(data?.params ?? null) };
  }

  async upsertCombistatoParams(
    combistatoId: string,
    params: CombistatoFormModel
  ): Promise<{ error?: string }> {
    if (!this.cloudEnabled() || !isUuid(combistatoId)) {
      return { error: 'Solo disponible con sesión y tabla combistatos en la nube.' };
    }
    const nowIso = new Date().toISOString();
    const { error } = await this.auth.client
      .from('combistatos')
      .update({
        params: combistatoToJsonBlob(params),
        updated_at: nowIso,
      })
      .eq('id', combistatoId);
    if (!error) {
      void this.hydrateFromCloud();
    }
    return { error: error?.message };
  }
}
