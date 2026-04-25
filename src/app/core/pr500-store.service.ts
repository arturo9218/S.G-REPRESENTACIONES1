import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  mergePr500Params,
  pr500ToJsonBlob,
  type Pr500FormModel,
} from '../pr500/pr500-params.defaults';
import { AuthService } from './auth.service';
import type { DashboardPr500 } from './models/dashboard.models';
import { ingestFunctionUrl, isSupabaseConfigured } from './supabase-config';

const TOKEN_MAP_PREFIX = 'ar-monitor-pr500-tokens-v1';

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export type AddPr500Result =
  | {
      ok: true;
      id: string;
      credentials: { moduleId: string; deviceToken: string; ingestUrl: string };
    }
  | { ok: false; error: string };

@Injectable({
  providedIn: 'root',
})
export class Pr500StoreService {
  private userScopeKey = 'anon';
  private readonly subject = new BehaviorSubject<DashboardPr500[]>([]);
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  readonly pr500s$ = this.subject.asObservable();

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {
    void this.hydrateFromCloud();
    this.auth.client.auth.onAuthStateChange((_event, session) => {
      this.userScopeKey = session?.user?.id ?? 'anon';
      if (!session?.user?.id) {
        this.clearPr500Poll();
      }
      this.zone.run(() => void this.hydrateFromCloud());
    });
  }

  get snapshot(): DashboardPr500[] {
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
    return `PR5-${this.randomHex(4)}`;
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

  private saveToken(id: string, token: string): void {
    const m = this.readTokenMap();
    m[id] = token;
    localStorage.setItem(this.tokensStorageKey(), JSON.stringify(m));
  }

  private removeToken(id: string): void {
    const m = this.readTokenMap();
    delete m[id];
    localStorage.setItem(this.tokensStorageKey(), JSON.stringify(m));
  }

  /** Evita colisión de module_id con devices, combistatos u otros PR500. */
  private async moduleIdTakenInCloud(moduleId: string): Promise<boolean> {
    const [{ data: d }, { data: c }, { data: p }] = await Promise.all([
      this.auth.client.from('devices').select('id').eq('module_id', moduleId).maybeSingle(),
      this.auth.client.from('combistatos').select('id').eq('module_id', moduleId).maybeSingle(),
      this.auth.client.from('pr500_controllers').select('id').eq('module_id', moduleId).maybeSingle(),
    ]);
    return d != null || c != null || p != null;
  }

  private async tokenInUseInCloud(token: string): Promise<boolean> {
    const [{ data: c }, { data: p }] = await Promise.all([
      this.auth.client.from('combistatos').select('id').eq('device_token_hash', token).maybeSingle(),
      this.auth.client.from('pr500_controllers').select('id').eq('device_token_hash', token).maybeSingle(),
    ]);
    return c != null || p != null;
  }

  private async randomPr500TokenAsync(): Promise<string> {
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

  private clearPr500Poll(): void {
    if (this.pollHandle != null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private ensurePr500Poll(): void {
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

  private pr500OnlineFromLastSeen(lastSeenIso: string | null | undefined): boolean {
    if (!lastSeenIso || typeof lastSeenIso !== 'string') return false;
    const atMs = new Date(lastSeenIso).getTime();
    if (!Number.isFinite(atMs)) return false;
    const offlineAfterMs =
      typeof environment.deviceOfflineAfterMs === 'number' && environment.deviceOfflineAfterMs > 0
        ? environment.deviceOfflineAfterMs
        : 90000;
    return Date.now() - atMs <= offlineAfterMs;
  }

  /** Una consulta por controlador: última fila de presión para las tarjetas del panel. */
  private async fetchLatestPr500Readings(
    ids: string[]
  ): Promise<
    Map<
      string,
      {
        pressure_bar: number;
        comp1_on: boolean;
        comp2_on: boolean;
        comp3_on: boolean;
        alarm_on: boolean;
      }
    >
  > {
    const out = new Map<
      string,
      {
        pressure_bar: number;
        comp1_on: boolean;
        comp2_on: boolean;
        comp3_on: boolean;
        alarm_on: boolean;
      }
    >();
    if (!this.cloudEnabled() || ids.length === 0) {
      return out;
    }
    await Promise.all(
      ids.map(async (id) => {
        const { data, error } = await this.auth.client
          .from('pr500_readings')
          .select('pressure_bar, comp1_on, comp2_on, comp3_on, alarm_on')
          .eq('pr500_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error || !data) return;
        const row = data as {
          pressure_bar: number;
          comp1_on: boolean;
          comp2_on: boolean;
          comp3_on: boolean;
          alarm_on: boolean;
        };
        if (typeof row.pressure_bar !== 'number' || Number.isNaN(row.pressure_bar)) return;
        out.set(id, {
          pressure_bar: row.pressure_bar,
          comp1_on: !!row.comp1_on,
          comp2_on: !!row.comp2_on,
          comp3_on: !!row.comp3_on,
          alarm_on: !!row.alarm_on,
        });
      })
    );
    return out;
  }

  async hydrateFromCloud(): Promise<void> {
    if (!this.cloudEnabled()) {
      this.clearPr500Poll();
      this.subject.next([]);
      return;
    }
    const session = await this.auth.getSession();
    if (!session?.user.id) {
      this.clearPr500Poll();
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
        .from('pr500_controllers')
        .select(base)
        .order('name', { ascending: true });
      if (error) {
        if (error.message?.includes('Could not find') || error.code === '42P01') {
          this.subject.next([]);
          return;
        }
        console.warn('Supabase pr500_controllers:', error.message);
        this.subject.next([]);
        return;
      }
      rows = (data ?? []) as Row[];
    } else {
      const { data, error } = await this.auth.client
        .from('pr500_controllers')
        .select(base)
        .eq('owner_user_id', session.user.id)
        .order('name', { ascending: true });
      if (error) {
        if (error.message?.includes('Could not find') || error.code === '42P01') {
          this.subject.next([]);
          return;
        }
        console.warn('Supabase pr500_controllers:', error.message);
        this.subject.next([]);
        return;
      }
      rows = (data ?? []) as Row[];
    }

    const tokens = this.readTokenMap();
    const lastById = await this.fetchLatestPr500Readings(rows.map((r) => r.id));
    const mapped: DashboardPr500[] = rows.map((r) => {
      const lastSeenRaw = r.last_seen_at;
      const lastSeenStr =
        lastSeenRaw && typeof lastSeenRaw === 'string' && lastSeenRaw.trim() ? lastSeenRaw.trim() : null;
      const snap = lastById.get(r.id);
      return {
        id: r.id,
        name: r.name,
        location: (r.location ?? '').trim() || 'Sin ubicación',
        moduleId: (r.module_id ?? '').trim() || undefined,
        updatedAtLabel: this.formatUpdatedLabel(r.updated_at),
        lastSeenLabel: lastSeenStr ? this.formatUpdatedLabel(lastSeenStr) : 'Sin contacto aún',
        online: this.pr500OnlineFromLastSeen(lastSeenStr),
        ownerUserId: r.owner_user_id,
        deviceToken: tokens[r.id] ?? ((r.device_token_hash ?? '').trim() || undefined),
        lastPressureBar: snap?.pressure_bar ?? null,
        lastComp1On: snap?.comp1_on,
        lastComp2On: snap?.comp2_on,
        lastComp3On: snap?.comp3_on,
        lastAlarmOn: snap?.alarm_on,
      };
    });
    for (const c of mapped) {
      if (c.deviceToken) this.saveToken(c.id, c.deviceToken);
    }
    this.subject.next(mapped);
    this.ensurePr500Poll();
  }

  async addPr500FromFormAsync(input: {
    name: string;
    location: string;
    moduleId: string;
  }): Promise<AddPr500Result> {
    const name = input.name.trim();
    const location = input.location.trim() || 'Sin ubicación';
    let moduleId = input.moduleId.trim();
    if (name.length < 2) {
      return { ok: false, error: 'El nombre debe tener al menos 2 caracteres.' };
    }
    const session = await this.auth.getSession();
    if (!this.cloudEnabled() || !session?.user.id) {
      return { ok: false, error: 'Iniciá sesión con nube activa para crear controladores PR500.' };
    }
    if (!moduleId) {
      moduleId = this.randomModuleId();
      let tries = 0;
      while ((await this.moduleIdTakenInCloud(moduleId)) && tries < 8) {
        moduleId = this.randomModuleId();
        tries += 1;
      }
      if (await this.moduleIdTakenInCloud(moduleId)) {
        return { ok: false, error: 'No se pudo generar un ID módulo único. Intentá de nuevo.' };
      }
    } else if (await this.moduleIdTakenInCloud(moduleId)) {
      return {
        ok: false,
        error: 'Ese ID módulo ya existe (panel, combistato u otro PR500). Elegí otro o dejalo vacío.',
      };
    }
    const deviceToken = await this.randomPr500TokenAsync();
    const defaultParams = pr500ToJsonBlob(mergePr500Params(null));
    const { data, error } = await this.auth.client
      .from('pr500_controllers')
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
      const msg = error?.message ?? 'No se pudo crear el PR500';
      if (msg.includes('Could not find the table') || error?.code === '42P01') {
        return {
          ok: false,
          error:
            'Falta la tabla en Supabase. Ejecutá FRONTEND/supabase/sql/036_pr500_controllers.sql en el SQL Editor.',
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

  async updatePr500Meta(
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
    if (current?.moduleId !== moduleId && (await this.moduleIdTakenInCloud(moduleId))) {
      return { ok: false, error: 'Ese ID módulo ya está usado por otro equipo.' };
    }
    const nowIso = new Date().toISOString();
    const { error } = await this.auth.client
      .from('pr500_controllers')
      .update({ name, location, module_id: moduleId, updated_at: nowIso })
      .eq('id', id);
    if (error) {
      return { ok: false, error: error.message };
    }
    await this.hydrateFromCloud();
    return { ok: true };
  }

  async removePr500Async(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { ok: false, error: 'Identificador inválido o sin nube.' };
    }
    const { error } = await this.auth.client.from('pr500_controllers').delete().eq('id', id);
    if (error) {
      return { ok: false, error: error.message };
    }
    this.removeToken(id);
    await this.hydrateFromCloud();
    return { ok: true };
  }

  async fetchPr500Params(pr500Id: string): Promise<{ params: Pr500FormModel; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(pr500Id)) {
      return { params: mergePr500Params(null) };
    }
    const { data, error } = await this.auth.client
      .from('pr500_controllers')
      .select('params')
      .eq('id', pr500Id)
      .maybeSingle();
    if (error) {
      return { params: mergePr500Params(null), error: error.message };
    }
    return { params: mergePr500Params(data?.params ?? null) };
  }

  async upsertPr500Params(pr500Id: string, params: Pr500FormModel): Promise<{ error?: string }> {
    if (!this.cloudEnabled() || !isUuid(pr500Id)) {
      return { error: 'Solo disponible con sesión y tabla pr500_controllers en la nube.' };
    }
    const nowIso = new Date().toISOString();
    const { error } = await this.auth.client
      .from('pr500_controllers')
      .update({
        params: pr500ToJsonBlob(params),
        updated_at: nowIso,
      })
      .eq('id', pr500Id);
    if (!error) {
      void this.hydrateFromCloud();
    }
    return { error: error?.message };
  }
}
