import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  dataloggerToJsonBlob,
  mergeDataloggerParams,
  dataloggerEnabledSensorSlotIds,
  type DataloggerFormModel,
} from '../datalogger/datalogger-params.defaults';
import { correctDataloggerReadingRow } from '../datalogger/datalogger-calibration.utils';
import { AuthService } from './auth.service';
import type { DashboardDatalogger } from './models/dashboard.models';
import { ingestFunctionUrl, isSupabaseConfigured } from './supabase-config';

const TOKEN_MAP_PREFIX = 'ar-monitor-datalogger-tokens-v1';

const READINGS_SELECT =
  'temp1_c, temp2_c, temp3_c, temp4_c, temp5_c, temp6_c, current1_a, current2_a, current3_a, power1_w, power2_w, power3_w, press1_bar, press2_bar, temp1_raw_c, temp2_raw_c, temp3_raw_c, temp4_raw_c, temp5_raw_c, temp6_raw_c, current1_raw_a, current2_raw_a, current3_raw_a, power1_raw_w, power2_raw_w, power3_raw_w, press1_raw_bar, press2_raw_bar';

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export type AddDataloggerResult =
  | {
      ok: true;
      id: string;
      credentials: { moduleId: string; deviceToken: string; ingestUrl: string };
    }
  | { ok: false; error: string };

type ReadingSnap = {
  temp1_c: number | null;
  temp2_c: number | null;
  temp3_c: number | null;
  temp4_c: number | null;
  temp5_c: number | null;
  temp6_c: number | null;
  current1_a: number | null;
  current2_a: number | null;
  current3_a: number | null;
  power1_w: number | null;
  power2_w: number | null;
  power3_w: number | null;
  press1_bar: number | null;
  press2_bar: number | null;
};

@Injectable({
  providedIn: 'root',
})
export class DataloggerStoreService {
  private userScopeKey = 'anon';
  private readonly subject = new BehaviorSubject<DashboardDatalogger[]>([]);
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  readonly dataloggers$ = this.subject.asObservable();

  constructor(
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {
    void this.hydrateFromCloud();
    this.auth.client.auth.onAuthStateChange((_event, session) => {
      this.userScopeKey = session?.user?.id ?? 'anon';
      if (!session?.user?.id) this.clearPoll();
      this.zone.run(() => void this.hydrateFromCloud());
    });
  }

  get snapshot(): DashboardDatalogger[] {
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
    return `DLG-${this.randomHex(4)}`;
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

  private async moduleIdTakenInCloud(moduleId: string): Promise<boolean> {
    const [{ data: d }, { data: c }, { data: p }, { data: dl }] = await Promise.all([
      this.auth.client.from('devices').select('id').eq('module_id', moduleId).maybeSingle(),
      this.auth.client.from('combistatos').select('id').eq('module_id', moduleId).maybeSingle(),
      this.auth.client.from('pr500_controllers').select('id').eq('module_id', moduleId).maybeSingle(),
      this.auth.client.from('datalogger_controllers').select('id').eq('module_id', moduleId).maybeSingle(),
    ]);
    return d != null || c != null || p != null || dl != null;
  }

  private async tokenInUseInCloud(token: string): Promise<boolean> {
    const [{ data: c }, { data: p }, { data: dl }] = await Promise.all([
      this.auth.client.from('combistatos').select('id').eq('device_token_hash', token).maybeSingle(),
      this.auth.client.from('pr500_controllers').select('id').eq('device_token_hash', token).maybeSingle(),
      this.auth.client.from('datalogger_controllers').select('id').eq('device_token_hash', token).maybeSingle(),
    ]);
    return c != null || p != null || dl != null;
  }

  private async randomTokenAsync(): Promise<string> {
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

  private clearPoll(): void {
    if (this.pollHandle != null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private ensurePoll(): void {
    if (this.pollHandle != null) return;
    if (!this.cloudEnabled() || this.userScopeKey === 'anon') return;
    const pollMs =
      typeof environment.readingsPollIntervalMs === 'number' && environment.readingsPollIntervalMs >= 2000
        ? environment.readingsPollIntervalMs
        : 12000;
    this.pollHandle = setInterval(() => void this.hydrateFromCloud(), pollMs);
  }

  private onlineFromLastSeen(lastSeenIso: string | null | undefined): boolean {
    if (!lastSeenIso || typeof lastSeenIso !== 'string') return false;
    const atMs = new Date(lastSeenIso).getTime();
    if (!Number.isFinite(atMs)) return false;
    const offlineAfterMs =
      typeof environment.deviceOfflineAfterMs === 'number' && environment.deviceOfflineAfterMs > 0
        ? environment.deviceOfflineAfterMs
        : 90000;
    return Date.now() - atMs <= offlineAfterMs;
  }

  private static snapFromRow(
    row: Record<string, unknown>,
    params?: DataloggerFormModel
  ): ReadingSnap | null {
    const corrected = params ? correctDataloggerReadingRow(row, params) : null;
    const num = (k: string): number | null => {
      const v = corrected ? corrected[k] : row[k];
      return v != null && typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    if (
      num('temp1_c') == null &&
      num('temp2_c') == null &&
      num('temp3_c') == null &&
      num('temp4_c') == null &&
      num('temp5_c') == null &&
      num('temp6_c') == null &&
      num('current1_a') == null &&
      num('current2_a') == null &&
      num('current3_a') == null &&
      num('press1_bar') == null &&
      num('press2_bar') == null
    ) {
      return null;
    }
    return {
      temp1_c: num('temp1_c'),
      temp2_c: num('temp2_c'),
      temp3_c: num('temp3_c'),
      temp4_c: num('temp4_c'),
      temp5_c: num('temp5_c'),
      temp6_c: num('temp6_c'),
      current1_a: num('current1_a'),
      current2_a: num('current2_a'),
      current3_a: num('current3_a'),
      power1_w: num('power1_w'),
      power2_w: num('power2_w'),
      power3_w: num('power3_w'),
      press1_bar: num('press1_bar'),
      press2_bar: num('press2_bar'),
    };
  }

  private async fetchLatestReadings(
    ids: string[],
    paramsById: Map<string, DataloggerFormModel>
  ): Promise<Map<string, ReadingSnap>> {
    const out = new Map<string, ReadingSnap>();
    if (!this.cloudEnabled() || ids.length === 0) return out;
    await Promise.all(
      ids.map(async (id) => {
        const { data, error } = await this.auth.client
          .from('datalogger_readings')
          .select(READINGS_SELECT)
          .eq('datalogger_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error || !data) return;
        const snap = DataloggerStoreService.snapFromRow(
          data as Record<string, unknown>,
          paramsById.get(id)
        );
        if (snap) out.set(id, snap);
      })
    );
    return out;
  }

  async hydrateFromCloud(): Promise<void> {
    if (!this.cloudEnabled()) {
      this.clearPoll();
      this.subject.next([]);
      return;
    }
    const session = await this.auth.getSession();
    if (!session?.user.id) {
      this.clearPoll();
      this.subject.next([]);
      return;
    }
    const isAdmin = await this.auth.fetchIsAppAdmin();
    this.userScopeKey = session.user.id;
    const base =
      'id, owner_user_id, module_id, name, location, device_token_hash, updated_at, last_seen_at, params';

    type Row = {
      id: string;
      owner_user_id: string;
      module_id: string | null;
      name: string;
      location: string | null;
      device_token_hash: string | null;
      updated_at: string;
      last_seen_at?: string | null;
      params?: unknown;
    };

    const q = isAdmin
      ? this.auth.client.from('datalogger_controllers').select(base).order('name', { ascending: true })
      : this.auth.client
          .from('datalogger_controllers')
          .select(base)
          .eq('owner_user_id', session.user.id)
          .order('name', { ascending: true });

    const { data, error } = await q;
    if (error) {
      if (error.message?.includes('Could not find') || error.code === '42P01') {
        this.subject.next([]);
        return;
      }
      console.warn('Supabase datalogger_controllers:', error.message);
      this.subject.next([]);
      return;
    }

    const rows = (data ?? []) as Row[];
    const tokens = this.readTokenMap();
    const paramsById = new Map<string, DataloggerFormModel>();
    for (const r of rows) {
      paramsById.set(r.id, mergeDataloggerParams(r.params ?? null));
    }
    const lastById = await this.fetchLatestReadings(rows.map((r) => r.id), paramsById);
    const mapped: DashboardDatalogger[] = rows.map((r) => {
      const lastSeenStr =
        r.last_seen_at && typeof r.last_seen_at === 'string' && r.last_seen_at.trim()
          ? r.last_seen_at.trim()
          : null;
      const snap = lastById.get(r.id);
      const params = paramsById.get(r.id)!;
      return {
        id: r.id,
        name: r.name,
        location: (r.location ?? '').trim() || 'Sin ubicación',
        moduleId: (r.module_id ?? '').trim() || undefined,
        updatedAtLabel: this.formatUpdatedLabel(r.updated_at),
        lastSeenLabel: lastSeenStr ? this.formatUpdatedLabel(lastSeenStr) : 'Sin contacto aún',
        lastSeenAt: lastSeenStr,
        online: this.onlineFromLastSeen(lastSeenStr),
        ownerUserId: r.owner_user_id,
        deviceToken: tokens[r.id] ?? ((r.device_token_hash ?? '').trim() || undefined),
        enabledSensorSlots: dataloggerEnabledSensorSlotIds(params),
        lastTemp1C: snap?.temp1_c ?? null,
        lastTemp2C: snap?.temp2_c ?? null,
        lastTemp3C: snap?.temp3_c ?? null,
        lastTemp4C: snap?.temp4_c ?? null,
        lastTemp5C: snap?.temp5_c ?? null,
        lastTemp6C: snap?.temp6_c ?? null,
        lastCurrent1A: snap?.current1_a ?? null,
        lastCurrent2A: snap?.current2_a ?? null,
        lastCurrent3A: snap?.current3_a ?? null,
        lastPower1W: snap?.power1_w ?? null,
        lastPower2W: snap?.power2_w ?? null,
        lastPower3W: snap?.power3_w ?? null,
        lastPress1Bar: snap?.press1_bar ?? null,
        lastPress2Bar: snap?.press2_bar ?? null,
      };
    });
    for (const c of mapped) {
      if (c.deviceToken) this.saveToken(c.id, c.deviceToken);
    }
    this.subject.next(mapped);
    this.ensurePoll();
  }

  async addDataloggerFromFormAsync(input: {
    name: string;
    location: string;
    moduleId: string;
  }): Promise<AddDataloggerResult> {
    const name = input.name.trim();
    const location = input.location.trim() || 'Sin ubicación';
    let moduleId = input.moduleId.trim();
    if (name.length < 2) {
      return { ok: false, error: 'El nombre debe tener al menos 2 caracteres.' };
    }
    const session = await this.auth.getSession();
    if (!this.cloudEnabled() || !session?.user.id) {
      return { ok: false, error: 'Iniciá sesión con nube activa para crear dataloggers.' };
    }
    if (!moduleId) {
      moduleId = this.randomModuleId();
      let tries = 0;
      while ((await this.moduleIdTakenInCloud(moduleId)) && tries < 8) {
        moduleId = this.randomModuleId();
        tries += 1;
      }
      if (await this.moduleIdTakenInCloud(moduleId)) {
        return { ok: false, error: 'No se pudo generar un ID módulo único.' };
      }
    } else if (await this.moduleIdTakenInCloud(moduleId)) {
      return { ok: false, error: 'Ese ID módulo ya existe en otro equipo.' };
    }
    const deviceToken = await this.randomTokenAsync();
    const { data, error } = await this.auth.client
      .from('datalogger_controllers')
      .insert({
        owner_user_id: session.user.id,
        module_id: moduleId,
        name,
        location,
        device_token_hash: deviceToken,
        params: dataloggerToJsonBlob(mergeDataloggerParams(null)),
      })
      .select('id')
      .single();
    if (error || !data) {
      const msg = error?.message ?? 'No se pudo crear el datalogger';
      if (msg.includes('Could not find') || error?.code === '42P01') {
        return {
          ok: false,
          error: 'Falta la tabla en Supabase. Ejecutá 058_datalogger_controllers.sql.',
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
      credentials: { moduleId, deviceToken, ingestUrl: this.getIngestUrl() },
    };
  }

  async updateDataloggerMeta(
    id: string,
    patch: { name: string; location: string; moduleId: string }
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { ok: false, error: 'Identificador inválido o sin nube.' };
    }
    const name = patch.name.trim();
    const location = patch.location.trim() || 'Sin ubicación';
    const moduleId = patch.moduleId.trim();
    if (name.length < 2) return { ok: false, error: 'Nombre demasiado corto.' };
    if (!moduleId) return { ok: false, error: 'ID módulo requerido.' };
    const current = this.snapshot.find((c) => c.id === id);
    if (current?.moduleId !== moduleId && (await this.moduleIdTakenInCloud(moduleId))) {
      return { ok: false, error: 'ID módulo ya usado.' };
    }
    const { error } = await this.auth.client
      .from('datalogger_controllers')
      .update({ name, location, module_id: moduleId, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return { ok: false, error: error.message };
    await this.hydrateFromCloud();
    return { ok: true };
  }

  async removeDataloggerAsync(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { ok: false, error: 'Identificador inválido.' };
    }
    const { error } = await this.auth.client.from('datalogger_controllers').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    this.removeToken(id);
    await this.hydrateFromCloud();
    return { ok: true };
  }

  async fetchDataloggerParams(id: string): Promise<{ params: DataloggerFormModel; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { params: mergeDataloggerParams(null) };
    }
    const { data, error } = await this.auth.client
      .from('datalogger_controllers')
      .select('params')
      .eq('id', id)
      .maybeSingle();
    if (error) return { params: mergeDataloggerParams(null), error: error.message };
    return { params: mergeDataloggerParams(data?.params ?? null) };
  }

  async upsertDataloggerParams(id: string, params: DataloggerFormModel): Promise<{ error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { error: 'Solo con sesión y tabla datalogger_controllers.' };
    }
    const { error } = await this.auth.client
      .from('datalogger_controllers')
      .update({
        params: dataloggerToJsonBlob(mergeDataloggerParams(params)),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (!error) void this.hydrateFromCloud();
    return { error: error?.message };
  }
}
