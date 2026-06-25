import { Injectable, NgZone } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  CombistatoFormModel,
  combistatoToJsonBlob,
  mergeCombistatoParams,
} from '../combistato/combistato-params.defaults';
import { AuthService } from './auth.service';
import { DashboardCombistato, CombistatoMemberPermissions, DashboardDeviceAccessRole } from './models/dashboard.models';
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
  private realtimeChannel: RealtimeChannel | null = null;
  private realtimeCombistatoIds: string[] = [];
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
        this.clearCombistatoRealtime();
      }
      this.zone.run(() => void this.hydrateFromCloud());
    });
  }

  get snapshot(): DashboardCombistato[] {
    return this.subject.value;
  }

  isCombistatoOwner(c: DashboardCombistato | null | undefined): boolean {
    if (!c) return false;
    return c.accessRole === 'owner' || c.accessRole === 'admin_view' || c.accessRole === undefined;
  }

  isCombistatoSharedMember(c: DashboardCombistato | null | undefined): boolean {
    return !!(c?.cloudSynced && (c.accessRole === 'viewer' || c.accessRole === 'editor'));
  }

  canViewCombistato(c: DashboardCombistato | null | undefined): boolean {
    if (!c) return false;
    if (this.isCombistatoOwner(c)) return true;
    return c.memberPermissions?.canView !== false;
  }

  canChartsCombistato(c: DashboardCombistato | null | undefined): boolean {
    if (!c) return false;
    if (this.isCombistatoOwner(c)) return true;
    return !!c.memberPermissions?.canCharts;
  }

  canEditCombistatoParams(c: DashboardCombistato | null | undefined): boolean {
    if (!c) return false;
    if (this.isCombistatoOwner(c)) return true;
    return !!c.memberPermissions?.canEditParams;
  }

  canFichaCombistato(c: DashboardCombistato | null | undefined): boolean {
    if (!c) return false;
    if (this.isCombistatoOwner(c)) return true;
    return !!c.memberPermissions?.canFicha;
  }

  canCommandsCombistato(c: DashboardCombistato | null | undefined): boolean {
    if (!c) return false;
    if (this.isCombistatoOwner(c)) return true;
    return !!c.memberPermissions?.canCommands;
  }

  canDeleteCombistato(c: DashboardCombistato | null | undefined): boolean {
    if (!c || this.isCombistatoSharedMember(c)) return false;
    if (c.ownerUserId && this.userScopeKey !== 'anon' && c.ownerUserId === this.userScopeKey) {
      return true;
    }
    return c.accessRole === 'owner';
  }

  canManageCombistatoMembers(c: DashboardCombistato | null | undefined): boolean {
    if (!c || this.isCombistatoSharedMember(c)) return false;
    if (c.ownerUserId && this.userScopeKey !== 'anon' && c.ownerUserId === this.userScopeKey) {
      return true;
    }
    return c.accessRole === 'owner';
  }

  async removeCombistatoMemberAsync(
    combistatoId: string,
    memberUserId: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(combistatoId) || !memberUserId) {
      return { ok: false, error: 'Datos inválidos o sin nube.' };
    }
    const c = this.snapshot.find((x) => x.id === combistatoId);
    if (!this.canManageCombistatoMembers(c)) {
      return { ok: false, error: 'Solo el dueño puede quitar invitados.' };
    }
    const { error } = await this.auth.client
      .from('combistato_members')
      .delete()
      .eq('combistato_id', combistatoId)
      .eq('member_user_id', memberUserId);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async leaveSharedCombistatoAsync(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.cloudEnabled() || !isUuid(id)) {
      return { ok: false, error: 'Identificador inválido o sin nube.' };
    }
    const session = await this.auth.getSession();
    if (!session?.user.id) {
      return { ok: false, error: 'Iniciá sesión.' };
    }
    const c = this.snapshot.find((x) => x.id === id);
    if (!c || !this.isCombistatoSharedMember(c)) {
      return { ok: false, error: 'Solo aplica a equipos PRO300 compartidos contigo.' };
    }
    const { error } = await this.auth.client
      .from('combistato_members')
      .delete()
      .eq('combistato_id', id)
      .eq('member_user_id', session.user.id);
    if (error) {
      return { ok: false, error: error.message };
    }
    await this.hydrateFromCloud();
    return { ok: true };
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

  private clearCombistatoRealtime(): void {
    if (this.realtimeChannel != null) {
      void this.auth.client.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
    this.realtimeCombistatoIds = [];
  }

  private combistatoPollIntervalMs(): number {
    const env = environment as {
      combistatoReadingsPollIntervalMs?: number;
      readingsPollIntervalMs?: number;
    };
    if (
      typeof env.combistatoReadingsPollIntervalMs === 'number' &&
      env.combistatoReadingsPollIntervalMs >= 10000
    ) {
      return env.combistatoReadingsPollIntervalMs;
    }
    if (typeof env.readingsPollIntervalMs === 'number' && env.readingsPollIntervalMs >= 2000) {
      return env.readingsPollIntervalMs;
    }
    return 45000;
  }

  private ensureCombistatoPoll(): void {
    if (this.pollHandle != null) return;
    if (!this.cloudEnabled() || this.userScopeKey === 'anon') return;
    const pollMs = this.combistatoPollIntervalMs();
    this.pollHandle = setInterval(() => {
      void this.hydrateFromCloud();
    }, pollMs);
  }

  /** Aplica una fila nueva de combistato_readings al snapshot del panel (sin reconsultar todo). */
  private applyCombistatoReadingRow(
    combistatoId: string,
    row: {
      created_at?: string;
      temp1_c?: number | null;
      temp2_c?: number | null;
      comp_on?: boolean | null;
      fan_on?: boolean | null;
      defrost_on?: boolean | null;
      door_open?: boolean | null;
      phase?: string | null;
      phase_elapsed_s?: number | null;
      phase_total_s?: number | null;
      comp_forced_remaining_s?: number | null;
      fan_forced_remaining_s?: number | null;
    }
  ): void {
    const list = this.subject.value;
    const idx = list.findIndex((c) => c.id === combistatoId);
    if (idx < 0) return;
    const prev = list[idx];
    const createdAt =
      typeof row.created_at === 'string' && row.created_at.trim()
        ? row.created_at.trim()
        : prev.lastSeenAt;
    const updated: DashboardCombistato = {
      ...prev,
      lastSeenAt: createdAt ?? prev.lastSeenAt,
      lastSeenLabel: createdAt ? this.formatUpdatedLabel(createdAt) : prev.lastSeenLabel,
      online: this.combistatoOnlineFromLastSeen(createdAt ?? prev.lastSeenAt),
      lastTemp1C: typeof row.temp1_c === 'number' ? row.temp1_c : prev.lastTemp1C,
      lastTemp2C:
        row.temp2_c === null || row.temp2_c === undefined
          ? prev.lastTemp2C
          : typeof row.temp2_c === 'number'
            ? row.temp2_c
            : prev.lastTemp2C,
      lastCompOn: typeof row.comp_on === 'boolean' ? row.comp_on : prev.lastCompOn,
      lastFanOn: typeof row.fan_on === 'boolean' ? row.fan_on : prev.lastFanOn,
      lastDefrostOn: typeof row.defrost_on === 'boolean' ? row.defrost_on : prev.lastDefrostOn,
      lastDoorOpen: typeof row.door_open === 'boolean' ? row.door_open : prev.lastDoorOpen,
      lastPhase:
        typeof row.phase === 'string' && row.phase.trim()
          ? (row.phase.trim() as DashboardCombistato['lastPhase'])
          : prev.lastPhase,
      lastPhaseElapsedS:
        typeof row.phase_elapsed_s === 'number' && Number.isFinite(row.phase_elapsed_s)
          ? row.phase_elapsed_s
          : prev.lastPhaseElapsedS,
      lastPhaseTotalS:
        typeof row.phase_total_s === 'number' && Number.isFinite(row.phase_total_s)
          ? row.phase_total_s
          : prev.lastPhaseTotalS,
      lastCompForcedRemainingS:
        typeof row.comp_forced_remaining_s === 'number' &&
        Number.isFinite(row.comp_forced_remaining_s)
          ? row.comp_forced_remaining_s
          : prev.lastCompForcedRemainingS,
      lastFanForcedRemainingS:
        typeof row.fan_forced_remaining_s === 'number' &&
        Number.isFinite(row.fan_forced_remaining_s)
          ? row.fan_forced_remaining_s
          : prev.lastFanForcedRemainingS,
    };
    const next = list.slice();
    next[idx] = updated;
    this.zone.run(() => this.subject.next(next));
  }

  /**
   * WebSocket: la UI reacciona en cuanto el ESP inserta (60 s + eventos), sin más polls ni más TX.
   */
  private ensureCombistatoRealtime(combistatoIds: string[]): void {
    if (!this.cloudEnabled() || this.userScopeKey === 'anon' || !combistatoIds.length) {
      this.clearCombistatoRealtime();
      return;
    }
    const sorted = [...combistatoIds].sort();
    if (
      this.realtimeChannel != null &&
      sorted.length === this.realtimeCombistatoIds.length &&
      sorted.every((id, i) => id === this.realtimeCombistatoIds[i])
    ) {
      return;
    }
    this.clearCombistatoRealtime();
    this.realtimeCombistatoIds = sorted;
    const idSet = new Set(sorted);
    this.realtimeChannel = this.auth.client
      .channel(`combistato-readings:${this.userScopeKey}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'combistato_readings' },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const cid = row['combistato_id'];
          if (typeof cid !== 'string' || !idSet.has(cid)) return;
          this.applyCombistatoReadingRow(cid, {
            created_at: typeof row['created_at'] === 'string' ? row['created_at'] : undefined,
            temp1_c: typeof row['temp1_c'] === 'number' ? row['temp1_c'] : null,
            temp2_c: typeof row['temp2_c'] === 'number' ? row['temp2_c'] : null,
            comp_on: typeof row['comp_on'] === 'boolean' ? row['comp_on'] : null,
            fan_on: typeof row['fan_on'] === 'boolean' ? row['fan_on'] : null,
            defrost_on: typeof row['defrost_on'] === 'boolean' ? row['defrost_on'] : null,
            door_open: typeof row['door_open'] === 'boolean' ? row['door_open'] : null,
            phase: typeof row['phase'] === 'string' ? row['phase'] : null,
            phase_elapsed_s:
              typeof row['phase_elapsed_s'] === 'number' ? row['phase_elapsed_s'] : null,
            phase_total_s:
              typeof row['phase_total_s'] === 'number' ? row['phase_total_s'] : null,
            comp_forced_remaining_s:
              typeof row['comp_forced_remaining_s'] === 'number'
                ? row['comp_forced_remaining_s']
                : null,
            fan_forced_remaining_s:
              typeof row['fan_forced_remaining_s'] === 'number'
                ? row['fan_forced_remaining_s']
                : null,
          });
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') {
          console.warn('Supabase Realtime combistato_readings: canal en error (se usa poll de respaldo).');
        }
      });
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

  /**
   * Una consulta por combistato a `combistato_readings` para la última fila.
   * Vuelve un Map combistatoId → snapshot. Si la tabla no existe (instancias
   * que aún no corrieron `035_combistato_readings.sql`), devuelve vacío sin
   * romper la pantalla.
   */
  private async fetchLatestCombistatoReadings(ids: string[]): Promise<
    Map<
      string,
      {
        temp1: number | null;
        temp2: number | null;
        comp: boolean | null;
        fan: boolean | null;
        defrost: boolean | null;
        door: boolean | null;
        phase: string | null;
        phaseElapsed: number | null;
        phaseTotal: number | null;
        compForcedRemaining: number | null;
        fanForcedRemaining: number | null;
      }
    >
  > {
    const out = new Map<
      string,
      {
        temp1: number | null;
        temp2: number | null;
        comp: boolean | null;
        fan: boolean | null;
        defrost: boolean | null;
        door: boolean | null;
        phase: string | null;
        phaseElapsed: number | null;
        phaseTotal: number | null;
        compForcedRemaining: number | null;
        fanForcedRemaining: number | null;
      }
    >();
    if (!ids.length) return out;
    await Promise.all(
      ids.map(async (id) => {
        const { data, error } = await this.auth.client
          .from('combistato_readings')
          .select(
            'temp1_c, temp2_c, comp_on, fan_on, defrost_on, door_open, phase, phase_elapsed_s, phase_total_s, comp_forced_remaining_s, fan_forced_remaining_s'
          )
          .eq('combistato_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error || !data) return;
        const row = data as {
          temp1_c: number | null;
          temp2_c: number | null;
          comp_on: boolean | null;
          fan_on: boolean | null;
          defrost_on: boolean | null;
          door_open: boolean | null;
          phase: string | null;
          phase_elapsed_s: number | null;
          phase_total_s: number | null;
          comp_forced_remaining_s: number | null;
          fan_forced_remaining_s: number | null;
        };
        out.set(id, {
          temp1: typeof row.temp1_c === 'number' ? row.temp1_c : null,
          temp2: typeof row.temp2_c === 'number' ? row.temp2_c : null,
          comp: typeof row.comp_on === 'boolean' ? row.comp_on : null,
          fan: typeof row.fan_on === 'boolean' ? row.fan_on : null,
          defrost: typeof row.defrost_on === 'boolean' ? row.defrost_on : null,
          door: typeof row.door_open === 'boolean' ? row.door_open : null,
          phase: typeof row.phase === 'string' && row.phase.trim() ? row.phase.trim() : null,
          phaseElapsed:
            typeof row.phase_elapsed_s === 'number' && Number.isFinite(row.phase_elapsed_s)
              ? row.phase_elapsed_s
              : null,
          phaseTotal:
            typeof row.phase_total_s === 'number' && Number.isFinite(row.phase_total_s)
              ? row.phase_total_s
              : null,
          compForcedRemaining:
            typeof row.comp_forced_remaining_s === 'number' &&
            Number.isFinite(row.comp_forced_remaining_s)
              ? row.comp_forced_remaining_s
              : null,
          fanForcedRemaining:
            typeof row.fan_forced_remaining_s === 'number' &&
            Number.isFinite(row.fan_forced_remaining_s)
              ? row.fan_forced_remaining_s
              : null,
        });
      })
    );
    return out;
  }

  async hydrateFromCloud(): Promise<void> {
    if (!this.cloudEnabled()) {
      this.clearCombistatoPoll();
      this.clearCombistatoRealtime();
      this.subject.next([]);
      return;
    }
    const session = await this.auth.getSession();
    if (!session?.user.id) {
      this.clearCombistatoPoll();
      this.clearCombistatoRealtime();
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

    type RowWithAccess = Row & {
      _access: DashboardDeviceAccessRole;
      _perms?: CombistatoMemberPermissions;
    };

    const byId = new Map<string, RowWithAccess>();

    const mapMemberPerms = (r: Record<string, unknown>): CombistatoMemberPermissions => ({
      canView: r['can_view'] !== false,
      canCharts: r['can_charts'] === true,
      canEditParams: r['can_edit_params'] === true,
      canFicha: r['can_ficha'] === true,
      canCommands: r['can_commands'] === true,
      canPush: r['can_push'] === true,
    });

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
      for (const r of (data ?? []) as Row[]) {
        byId.set(r.id, { ...r, _access: 'admin_view' });
      }
    } else {
      const { data: owned, error: eOwned } = await this.auth.client
        .from('combistatos')
        .select(base)
        .eq('owner_user_id', session.user.id)
        .order('name', { ascending: true });
      if (eOwned) {
        if (eOwned.message?.includes('Could not find the table') || eOwned.code === '42P01') {
          this.subject.next([]);
          return;
        }
        console.warn('Supabase combistatos (propios):', eOwned.message);
        this.subject.next([]);
        return;
      }
      for (const r of (owned ?? []) as Row[]) {
        byId.set(r.id, { ...r, _access: 'owner' });
      }

      const { data: shared, error: eMem } = await this.auth.client
        .from('combistato_members')
        .select(
          'combistato_id, can_view, can_charts, can_edit_params, can_ficha, can_commands, can_push'
        )
        .eq('member_user_id', session.user.id);
      if (eMem) {
        const msg = eMem.message ?? '';
        if (!msg.includes('combistato_members') && !msg.includes('schema cache')) {
          console.warn('Supabase combistato_members:', msg);
        }
      } else if ((shared ?? []).length > 0) {
        const memberRows = shared as {
          combistato_id: string;
          can_view?: boolean;
          can_charts?: boolean;
          can_edit_params?: boolean;
          can_ficha?: boolean;
          can_commands?: boolean;
          can_push?: boolean;
        }[];
        const sharedIds = [...new Set(memberRows.map((r) => r.combistato_id).filter(Boolean))];
        const { data: combiRows, error: eCombi } = await this.auth.client
          .from('combistatos')
          .select(base)
          .in('id', sharedIds);
        if (eCombi) {
          console.warn('Supabase combistatos (compartidos):', eCombi.message);
        }
        const combiById = new Map(((combiRows ?? []) as Row[]).map((r) => [r.id, r]));
        for (const row of memberRows) {
          const combi = combiById.get(row.combistato_id);
          if (!combi?.id) continue;
          const perms = mapMemberPerms(row as Record<string, unknown>);
          const role: DashboardDeviceAccessRole = perms.canEditParams ? 'editor' : 'viewer';
          const prev = byId.get(combi.id);
          if (prev?._access === 'owner') continue;
          byId.set(combi.id, { ...combi, _access: role, _perms: perms });
        }
        if (sharedIds.length > 0 && combiById.size === 0) {
          console.warn(
            'combistato_members tiene filas pero combistatos no devolvió datos (revisá RLS o permisos can_view).'
          );
        }
      }
    }

    const rows = [...byId.values()].sort((a, b) =>
      (a.name ?? '').localeCompare(b.name ?? '', 'es', { sensitivity: 'base' })
    );

    const tokens = this.readTokenMap();
    const lastById = await this.fetchLatestCombistatoReadings(rows.map((r) => r.id));
    const mapped: DashboardCombistato[] = rows.map((r) => {
      const lastSeenRaw = r.last_seen_at;
      const lastSeenStr =
        lastSeenRaw && typeof lastSeenRaw === 'string' && lastSeenRaw.trim() ? lastSeenRaw.trim() : null;
      const snap = lastById.get(r.id);
      const merged = mergeCombistatoParams(r.params ?? null);
      const isOwnerRow = r._access === 'owner' || r._access === 'admin_view';
      return {
        id: r.id,
        name: r.name,
        location: (r.location ?? '').trim() || 'Sin ubicación',
        moduleId: (r.module_id ?? '').trim() || undefined,
        updatedAtLabel: this.formatUpdatedLabel(r.updated_at),
        lastSeenLabel: lastSeenStr ? this.formatUpdatedLabel(lastSeenStr) : 'Sin contacto aún',
        lastSeenAt: lastSeenStr,
        online: this.combistatoOnlineFromLastSeen(lastSeenStr),
        ownerUserId: r.owner_user_id,
        deviceToken: isOwnerRow
          ? tokens[r.id] ?? ((r.device_token_hash ?? '').trim() || undefined)
          : undefined,
        accessRole: r._access,
        memberPermissions: r._perms,
        cloudSynced: true,
        lastTemp1C: snap?.temp1 ?? null,
        lastTemp2C: snap?.temp2 ?? null,
        lastCompOn: snap?.comp ?? null,
        lastFanOn: snap?.fan ?? null,
        lastDefrostOn: snap?.defrost ?? null,
        lastDoorOpen: snap?.door ?? null,
        lastPhase: (snap?.phase as DashboardCombistato['lastPhase']) ?? null,
        lastPhaseElapsedS: snap?.phaseElapsed ?? null,
        lastPhaseTotalS: snap?.phaseTotal ?? null,
        defrostTargetC: Number.isFinite(merged.F08) ? merged.F08 : null,
        lastCompForcedRemainingS: snap?.compForcedRemaining ?? null,
        lastFanForcedRemainingS: snap?.fanForcedRemaining ?? null,
        alarmHighC: Number.isFinite(merged.F13) ? merged.F13 : null,
        alarmLowC: Number.isFinite(merged.F14) ? merged.F14 : null,
        alarmDelayMin: Number.isFinite(merged.F15) ? merged.F15 : null,
        alarmHysteresisC: Number.isFinite(merged.F47) ? merged.F47 : null,
      };
    });
    for (const c of mapped) {
      if (c.deviceToken) this.saveToken(c.id, c.deviceToken);
    }
    this.subject.next(mapped);
    this.ensureCombistatoRealtime(mapped.map((c) => c.id));
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
    if (!this.isCombistatoOwner(current)) {
      return { ok: false, error: 'Solo el dueño puede cambiar nombre, ubicación o ID módulo.' };
    }
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
    const current = this.snapshot.find((c) => c.id === id);
    if (!this.canDeleteCombistato(current)) {
      return { ok: false, error: 'Solo el dueño puede eliminar este PRO300.' };
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
    const current = this.snapshot.find((c) => c.id === combistatoId);
    if (!this.canEditCombistatoParams(current)) {
      return { error: 'No tenés permiso para editar parámetros de este PRO300.' };
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
