/**
 * Dispositivos: localStorage por usuario + opcional sincronización Supabase (ESP → Edge Function → DB).
 * El token del dispositivo se genera al crear; el técnico lo copia a WiFiManager del ESP.
 */

import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { ingestFunctionUrl, isSupabaseConfigured } from './supabase-config';
import {
  DashboardDevice,
  DeviceAlarmEvent,
  TemperatureReading,
} from './models/dashboard.models';

const STORAGE_KEY_PREFIX = 'ar-monitor-devices-v2';
const READINGS_KEY_PREFIX = 'ar-monitor-readings-v2';
const TOKEN_MAP_PREFIX = 'ar-monitor-device-tokens-v2';
/**
 * Máximo de lecturas en localStorage (tras merge con la nube).
 * La consulta a Supabase ya no usa un solo `limit` global: se pide historial por dispositivo
 * (ver CLOUD_READINGS_PER_DEVICE); si no, con ~15 s entre lecturas 5000 filas ≈ solo 24 h.
 */
const MAX_READINGS = 40000;

/** Lecturas más recientes a traer por cada dispositivo UUID (Supabase). */
const CLOUD_READINGS_PER_DEVICE = 25000;
const DEFAULT_SENSOR_1_LABEL = 'Sensor 1';
const DEFAULT_SENSOR_2_LABEL = 'Sensor 2';

export const DASHBOARD_SAMPLE_DEVICES: DashboardDevice[] = [
  {
    id: 'XYZ1234',
    name: 'Refrigerador #1',
    location: 'Bodega Frigorífica',
    temperatureC: 3.4,
    temperature2C: 3.1,
    online: true,
    updatedAtLabel: 'Hace 5 min',
    batteryPct: 88,
    sensor1Label: 'Evaporador',
    sensor2Label: 'Condensador',
  },
  {
    id: 'ABC9876',
    name: 'Cámara Frigorífica',
    location: 'Laboratorio Central',
    temperatureC: 2.1,
    temperature2C: 2.4,
    online: true,
    updatedAtLabel: 'Hace 12 min',
    batteryPct: 72,
    sensor1Label: 'Sensor A',
    sensor2Label: 'Sensor B',
  },
  {
    id: 'LMN5555',
    name: 'Espacio Bodega',
    location: 'Depósito Sur',
    temperatureC: 4.2,
    online: true,
    updatedAtLabel: 'Hace 1 h',
    batteryPct: 65,
    sensor1Label: 'Sensor 1',
    sensor2Label: 'Sensor 2',
  },
];

export interface NewDeviceInput {
  name: string;
  location: string;
  moduleId: string;
  espLocalIp: string;
}

export interface DeviceNotificationConfigInput {
  alertsEnabled: boolean;
  tempLowC: number | null;
  tempHighC: number | null;
  temp2LowC: number | null;
  temp2HighC: number | null;
  /** Corriente máx. RMS (A); null = sin límite */
  currentMaxA: number | null;
  /** Tensión nominal (V), p. ej. 220 o 380; null usa 220 en servidor */
  nominalVoltageV: number | null;
  tempPushCooldownMs: number | null;
  offlinePushCooldownMs: number | null;
}

/** Corrección de temperatura y consumo (sumas aplicadas en ingest-reading al guardar cada lectura). */
export interface DeviceTempCalibrationInput {
  temp1OffsetC: number;
  temp2OffsetC: number;
  temp3OffsetC: number;
  currentOffsetA: number;
  powerOffsetW: number;
}

export interface TelemetryInput {
  deviceId: string;
  temp1C: number;
  temp2C?: number | null;
  temp3C?: number | null;
  currentA?: number | null;
  powerW?: number | null;
  press1Bar?: number | null;
  press2Bar?: number | null;
  at?: string;
}

export type AddDeviceResult =
  | {
      ok: true;
      id: string;
      credentials?: { moduleId: string; deviceToken: string; ingestUrl: string };
    }
  | { ok: false; error: string };

@Injectable({
  providedIn: 'root',
})
export class DeviceStoreService {
  private userScopeKey = 'anon';
  private readonly subject = new BehaviorSubject<DashboardDevice[]>([]);
  private readonly readingsSubject = new BehaviorSubject<TemperatureReading[]>([]);
  private readonly adminSubject = new BehaviorSubject<boolean>(false);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly devices$ = this.subject.asObservable();
  readonly readings$ = this.readingsSubject.asObservable();
  /** Sesión actual con email listado en environment.adminEmails (vista de todos los equipos). */
  readonly admin$ = this.adminSubject.asObservable();

  constructor(
    private readonly auth: AuthService,
    private readonly ngZone: NgZone
  ) {
    void this.bootstrapScope();
    this.auth.client.auth.onAuthStateChange((_event, session) => {
      void this.auth.fetchIsAppAdmin().then((v) => this.adminSubject.next(v));
      const nextScope = session?.user.id ?? 'anon';
      this.setScope(nextScope);
    });
  }

  get isAdminView(): boolean {
    return this.adminSubject.value;
  }

  get snapshot(): DashboardDevice[] {
    return this.subject.value;
  }

  get readingsSnapshot(): TemperatureReading[] {
    return this.readingsSubject.value;
  }

  /** True si hay sesión y está activa la sync con Supabase. */
  isUsingCloudSync(): boolean {
    return this.isCloudSyncEnabled();
  }

  /** Revalida el scope usando la sesión actual (útil al abrir una pestaña nueva). */
  refreshScopeFromSession(): void {
    void this.bootstrapScope();
  }

  /** Fuerza una actualización inmediata de lecturas desde la nube. */
  forceRefreshCloudReadings(): void {
    if (!this.isCloudSyncEnabled()) return;
    void this.refreshReadingsFromCloud();
  }

  /** Recarga dispositivos, umbrales (incl. offsets) y lecturas desde Supabase. */
  forceRefreshAllFromCloud(): void {
    if (!this.isCloudSyncEnabled()) return;
    void this.hydrateFromCloud();
  }

  /** URL del endpoint que debe usar el ESP en WiFiManager (`api_url`). */
  getIngestUrl(): string {
    return ingestFunctionUrl();
  }

  async addDeviceFromFormAsync(input: NewDeviceInput): Promise<AddDeviceResult> {
    const name = input.name.trim();
    const location = input.location.trim() || 'Sin ubicación';
    let moduleId = input.moduleId.trim();
    const espLocalIp = input.espLocalIp.trim();

    const session = await this.auth.getSession();
    if (this.isCloudSyncEnabled() && session?.user.id) {
      if (!moduleId) {
        moduleId = this.randomModuleId();
        let tries = 0;
        while ((await this.moduleExistsInSupabase(moduleId)) && tries < 8) {
          moduleId = this.randomModuleId();
          tries += 1;
        }
        if (await this.moduleExistsInSupabase(moduleId)) {
          return { ok: false, error: 'No se pudo generar un ID módulo único. Intentá de nuevo.' };
        }
      }

      const deviceToken = await this.randomDeviceTokenAsync();
      const { data, error } = await this.auth.client
        .from('devices')
        .insert({
          owner_user_id: session.user.id,
          module_id: moduleId,
          name,
          location,
          device_token_hash: deviceToken,
          active: true,
          sensor_1_label: DEFAULT_SENSOR_1_LABEL,
          sensor_2_label: DEFAULT_SENSOR_2_LABEL,
        })
        .select('id')
        .single();

      if (error || !data) {
        const msg = error?.message ?? 'No se pudo crear el dispositivo';
        if (msg.includes('duplicate') || msg.includes('unique')) {
          return { ok: false, error: 'Ese ID módulo ya existe. Elegí otro o dejalo vacío para generar uno.' };
        }
        return { ok: false, error: msg };
      }

      const id = data.id as string;
      void this.auth.client.from('device_thresholds').insert({
        device_id: id,
        notifications_enabled: true,
        temp1_min_c: 2,
        temp1_max_c: 8,
        temp2_min_c: 2,
        temp2_max_c: 8,
        nominal_voltage_v: 220,
        temp_push_cooldown_ms: 15 * 60 * 1000,
        offline_push_cooldown_ms: 15 * 60 * 1000,
        temp1_offset_c: 0,
        temp2_offset_c: 0,
        temp3_offset_c: 0,
        current_offset_a: 0,
        power_offset_w: 0,
        current_max_a: null,
        press1_min_bar: 1.8,
        press1_max_bar: 2.8,
        press2_min_bar: 1.8,
        press2_max_bar: 2.8,
      });

      this.saveDeviceToken(id, deviceToken);

      const device: DashboardDevice = {
        id,
        name,
        location,
        temperatureC: null,
        temperature2C: null,
        online: false,
        updatedAtLabel: 'Esperando dispositivo',
        batteryPct: null,
        moduleId,
        espLocalIp: espLocalIp || undefined,
        alertsEnabled: true,
        tempLowC: 2,
        tempHighC: 8,
        cloudSynced: true,
        deviceToken,
        sensor1Label: DEFAULT_SENSOR_1_LABEL,
        sensor2Label: DEFAULT_SENSOR_2_LABEL,
        temp1OffsetC: 0,
        temp2OffsetC: 0,
        temp3OffsetC: 0,
        currentOffsetA: 0,
        powerOffsetW: 0,
        tempPushCooldownMs: 15 * 60 * 1000,
        offlinePushCooldownMs: 15 * 60 * 1000,
        currentMaxA: null,
        nominalVoltageV: 220,
      };

      this.persistDevices([...this.snapshot.filter((d) => d.id !== id), device]);
      return {
        ok: true,
        id,
        credentials: {
          moduleId,
          deviceToken,
          ingestUrl: ingestFunctionUrl(),
        },
      };
    }

    const id = this.addDeviceFromFormLocal(name, location, moduleId, espLocalIp);
    return { ok: true, id };
  }

  private normalize(raw: unknown): DashboardDevice | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    const id = d['id'];
    const name = d['name'];
    if (typeof id !== 'string' || typeof name !== 'string') return null;
    const t = d['temperatureC'];
    const t2 = d['temperature2C'];
    return {
      id,
      name,
      location: typeof d['location'] === 'string' ? d['location'] : '',
      temperatureC: typeof t === 'number' && !Number.isNaN(t) ? t : null,
      temperature2C:
        typeof t2 === 'number' && !Number.isNaN(t2) ? t2 : t2 === null ? null : undefined,
      online: Boolean(d['online']),
      updatedAtLabel:
        typeof d['updatedAtLabel'] === 'string' ? d['updatedAtLabel'] : '—',
      batteryPct:
        typeof d['batteryPct'] === 'number' && !Number.isNaN(d['batteryPct'])
          ? d['batteryPct']
          : null,
      moduleId: typeof d['moduleId'] === 'string' ? d['moduleId'] : undefined,
      espLocalIp: typeof d['espLocalIp'] === 'string' ? d['espLocalIp'] : undefined,
      alertsEnabled: typeof d['alertsEnabled'] === 'boolean' ? d['alertsEnabled'] : true,
      tempLowC:
        typeof d['tempLowC'] === 'number' && !Number.isNaN(d['tempLowC']) ? d['tempLowC'] : 2,
      tempHighC:
        typeof d['tempHighC'] === 'number' && !Number.isNaN(d['tempHighC']) ? d['tempHighC'] : 8,
      temp2LowC:
        typeof d['temp2LowC'] === 'number' && !Number.isNaN(d['temp2LowC'])
          ? d['temp2LowC']
          : typeof d['tempLowC'] === 'number' && !Number.isNaN(d['tempLowC'])
            ? d['tempLowC']
            : 2,
      temp2HighC:
        typeof d['temp2HighC'] === 'number' && !Number.isNaN(d['temp2HighC'])
          ? d['temp2HighC']
          : typeof d['tempHighC'] === 'number' && !Number.isNaN(d['tempHighC'])
            ? d['tempHighC']
            : 8,
      currentMaxA:
        d['currentMaxA'] === null
          ? null
          : typeof d['currentMaxA'] === 'number' && !Number.isNaN(d['currentMaxA'] as number)
            ? (d['currentMaxA'] as number)
            : null,
      cloudSynced: typeof d['cloudSynced'] === 'boolean' ? d['cloudSynced'] : undefined,
      deviceToken: typeof d['deviceToken'] === 'string' ? d['deviceToken'] : undefined,
      sensor1Label:
        typeof d['sensor1Label'] === 'string' && d['sensor1Label'].trim()
          ? (d['sensor1Label'] as string).trim()
          : undefined,
      sensor2Label:
        typeof d['sensor2Label'] === 'string' && d['sensor2Label'].trim()
          ? (d['sensor2Label'] as string).trim()
          : undefined,
      temp1OffsetC:
        typeof d['temp1OffsetC'] === 'number' && !Number.isNaN(d['temp1OffsetC']) ? d['temp1OffsetC'] : 0,
      temp2OffsetC:
        typeof d['temp2OffsetC'] === 'number' && !Number.isNaN(d['temp2OffsetC']) ? d['temp2OffsetC'] : 0,
      temp3OffsetC:
        typeof d['temp3OffsetC'] === 'number' && !Number.isNaN(d['temp3OffsetC']) ? d['temp3OffsetC'] : 0,
      currentOffsetA:
        typeof d['currentOffsetA'] === 'number' && !Number.isNaN(d['currentOffsetA']) ? d['currentOffsetA'] : 0,
      powerOffsetW:
        typeof d['powerOffsetW'] === 'number' && !Number.isNaN(d['powerOffsetW']) ? d['powerOffsetW'] : 0,
    };
  }

  private readFromStorage(): DashboardDevice[] {
    try {
      const raw = localStorage.getItem(this.devicesStorageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x) => this.normalize(x))
        .filter((x): x is DashboardDevice => x != null);
    } catch {
      return [];
    }
  }

  private readReadingsFromStorage(): TemperatureReading[] {
    try {
      const raw = localStorage.getItem(this.readingsStorageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x) => {
          if (!x || typeof x !== 'object') return null;
          const r = x as Record<string, unknown>;
          if (
            typeof r['deviceId'] !== 'string' ||
            typeof r['at'] !== 'string' ||
            typeof r['temperatureC'] !== 'number'
          ) {
            return null;
          }
          return {
            deviceId: r['deviceId'],
            at: r['at'],
            temperatureC: r['temperatureC'],
            temp1RawC:
              typeof r['temp1RawC'] === 'number' && !Number.isNaN(r['temp1RawC']) ? r['temp1RawC'] : null,
            temp2RawC:
              typeof r['temp2RawC'] === 'number' && !Number.isNaN(r['temp2RawC']) ? r['temp2RawC'] : null,
            temp3RawC:
              typeof r['temp3RawC'] === 'number' && !Number.isNaN(r['temp3RawC']) ? r['temp3RawC'] : null,
            temp2C:
              typeof r['temp2C'] === 'number' && !Number.isNaN(r['temp2C']) ? r['temp2C'] : null,
            temp3C:
              typeof r['temp3C'] === 'number' && !Number.isNaN(r['temp3C']) ? r['temp3C'] : null,
            currentA:
              typeof r['currentA'] === 'number' && !Number.isNaN(r['currentA']) ? r['currentA'] : null,
            powerW:
              typeof r['powerW'] === 'number' && !Number.isNaN(r['powerW']) ? r['powerW'] : null,
            press1Bar:
              typeof r['press1Bar'] === 'number' && !Number.isNaN(r['press1Bar'])
                ? r['press1Bar']
                : null,
            press2Bar:
              typeof r['press2Bar'] === 'number' && !Number.isNaN(r['press2Bar'])
                ? r['press2Bar']
                : null,
            currentARaw:
              typeof r['currentARaw'] === 'number' && !Number.isNaN(r['currentARaw']) ? r['currentARaw'] : null,
            powerWRaw:
              typeof r['powerWRaw'] === 'number' && !Number.isNaN(r['powerWRaw']) ? r['powerWRaw'] : null,
          } as TemperatureReading;
        })
        .filter((x): x is TemperatureReading => x != null);
    } catch {
      return [];
    }
  }

  private persistDevices(list: DashboardDevice[]): void {
    localStorage.setItem(this.devicesStorageKey(), JSON.stringify(list));
    // Supabase/fetch suele resolver fuera de la zona de Angular: sin esto la UI no refresca sola.
    this.ngZone.run(() => this.subject.next(list));
  }

  private persistReadings(list: TemperatureReading[]): void {
    let max = MAX_READINGS;
    while (max >= 1000) {
      const trimmed = list.slice(-max);
      try {
        localStorage.setItem(this.readingsStorageKey(), JSON.stringify(trimmed));
        this.ngZone.run(() => this.readingsSubject.next(trimmed));
        return;
      } catch {
        max = Math.floor(max / 2);
      }
    }
  }

  private devicesStorageKey(): string {
    return `${STORAGE_KEY_PREFIX}:${this.userScopeKey}`;
  }

  private readingsStorageKey(): string {
    return `${READINGS_KEY_PREFIX}:${this.userScopeKey}`;
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

  private saveDeviceToken(deviceId: string, token: string): void {
    const m = this.readTokenMap();
    m[deviceId] = token;
    localStorage.setItem(this.tokensStorageKey(), JSON.stringify(m));
  }

  private removeDeviceToken(deviceId: string): void {
    const m = this.readTokenMap();
    delete m[deviceId];
    localStorage.setItem(this.tokensStorageKey(), JSON.stringify(m));
  }

  private async bootstrapScope(): Promise<void> {
    let session = await this.auth.getSession();
    if (!session) {
      // En pestaña nueva, Supabase puede tardar en restaurar token de sesión.
      for (let i = 0; i < 12 && !session; i++) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        session = await this.auth.getSession();
      }
    }
    this.setScope(session?.user.id ?? 'anon');
  }

  private setScope(scope: string): void {
    this.userScopeKey = scope || 'anon';
    this.subject.next(this.readFromStorage());
    this.readingsSubject.next(this.readReadingsFromStorage());
    if (this.pollHandle != null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.isCloudSyncEnabled()) {
      void this.hydrateFromCloud();
      const pollMs =
        typeof environment.readingsPollIntervalMs === 'number' &&
        environment.readingsPollIntervalMs >= 2000
          ? environment.readingsPollIntervalMs
          : 4000;
      this.pollHandle = setInterval(() => {
        void this.refreshReadingsFromCloud();
      }, pollMs);
    }
  }

  private isCloudSyncEnabled(): boolean {
    return (
      environment.deviceCloudSync === true &&
      isSupabaseConfigured() &&
      this.userScopeKey !== 'anon'
    );
  }

  /** Sesión con Supabase y sync activado (p. ej. historial largo por RPC). */
  isCloudSyncActive(): boolean {
    return this.isCloudSyncEnabled();
  }

  /**
   * Historial de alarmas guardadas en la nube (tabla device_alarm_events).
   * Dueño y admin pueden listar; requiere 013_device_alarm_events.sql.
   */
  async fetchAlarmHistory(): Promise<{ rows: DeviceAlarmEvent[]; error: string | null }> {
    if (!this.isCloudSyncEnabled()) {
      return { rows: [], error: null };
    }
    const { data, error } = await this.auth.client
      .from('device_alarm_events')
      .select('id, device_id, triggered_at, kind, message, detail, temp1_c, temp2_c, power_w, current_a')
      .order('triggered_at', { ascending: false })
      .limit(200);
    if (error) {
      if (error.message?.includes('Could not find the table') || error.code === '42P01') {
        return {
          rows: [],
          error:
            'Ejecutá en Supabase el SQL: FRONTEND/supabase/sql/013_device_alarm_events.sql',
        };
      }
      return { rows: [], error: error.message };
    }
    const rows: DeviceAlarmEvent[] = (data as Record<string, unknown>[]).map((row) => {
      const rawKind = row['kind'];
      const kind: DeviceAlarmEvent['kind'] =
        rawKind === 'offline'
          ? 'offline'
          : rawKind === 'current_breach' || rawKind === 'power_breach'
            ? 'current_breach'
            : 'temp_breach';
      return {
        id: String(row['id'] ?? ''),
        deviceId: String(row['device_id'] ?? ''),
        triggeredAt:
          typeof row['triggered_at'] === 'string' ? row['triggered_at'] : new Date().toISOString(),
        kind,
        message: typeof row['message'] === 'string' ? row['message'] : '',
        detail: typeof row['detail'] === 'string' ? row['detail'] : null,
        temp1C:
          typeof row['temp1_c'] === 'number' && Number.isFinite(row['temp1_c'] as number)
            ? (row['temp1_c'] as number)
            : null,
        temp2C:
          typeof row['temp2_c'] === 'number' && Number.isFinite(row['temp2_c'] as number)
            ? (row['temp2_c'] as number)
            : null,
        currentA:
          typeof row['current_a'] === 'number' && Number.isFinite(row['current_a'] as number)
            ? (row['current_a'] as number)
            : null,
        powerW:
          typeof row['power_w'] === 'number' && Number.isFinite(row['power_w'] as number)
            ? (row['power_w'] as number)
            : null,
      };
    });
    return { rows, error: null };
  }

  /**
   * Borra fila del historial y, según el tipo, resetea marcas de push en `device_thresholds`
   * (como si la condición se hubiera “cerrado”): el próximo aviso vuelve a exigir umbral + retardo.
   */
  async deleteAlarmEvent(ev: Pick<DeviceAlarmEvent, 'id' | 'deviceId' | 'kind'>): Promise<{
    error: string | null;
  }> {
    if (!this.isCloudSyncEnabled() || !ev.id) {
      return { error: null };
    }
    const { error } = await this.auth.client.from('device_alarm_events').delete().eq('id', ev.id);
    if (error) {
      return { error: error.message ?? null };
    }

    if (!this.isUuid(ev.deviceId)) {
      return { error: null };
    }

    const patch: Record<string, null> = {};
    if (ev.kind === 'temp_breach') {
      patch['temp_breach_episode_started_at'] = null;
      patch['last_push_temp_breach_at'] = null;
    } else if (ev.kind === 'current_breach') {
      patch['last_push_current_breach_at'] = null;
    } else if (ev.kind === 'offline') {
      patch['last_push_offline_at'] = null;
    }

    if (Object.keys(patch).length > 0) {
      const { error: uerr } = await this.auth.client
        .from('device_thresholds')
        .update(patch)
        .eq('device_id', ev.deviceId);
      if (uerr) {
        console.warn('[device-store] reset umbrales tras borrar alarma:', uerr.message);
      }
    }
    return { error: null };
  }

  private isUuid(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id
    );
  }

  /** Dispositivo con UUID en Supabase (historial en la nube). */
  isCloudDeviceId(id: string | null | undefined): boolean {
    return !!id && this.isUuid(id);
  }

  /**
   * Lecturas en un rango para el gráfico de análisis (RPC en Supabase).
   * Resolución: cruda / horaria / diaria según duración (ver sql/003_chart_readings_range.sql).
   */
  async fetchChartReadingsForRange(
    deviceId: string,
    fromIso: string,
    toIso: string
  ): Promise<{ rows: TemperatureReading[]; error: string | null }> {
    if (!this.isCloudSyncEnabled() || !this.isUuid(deviceId)) {
      return { rows: [], error: null };
    }
    const { data, error } = await this.auth.client.rpc('get_device_readings_chart', {
      p_device_id: deviceId,
      p_from: fromIso,
      p_to: toIso,
    });
    if (error) {
      console.warn('get_device_readings_chart:', error.message, error);
      if (this.isChartRpcMissingError(error.message)) {
        const direct = await this.fetchChartReadingsForRangeDirect(deviceId, fromIso, toIso);
        if (direct.error) {
          return direct;
        }
        // Sin función SQL: lecturas directas (puede ser [] si no hay datos en el rango).
        return { rows: direct.rows, error: null };
      }
      return { rows: [], error: this.formatChartRpcError(error.message) };
    }
    if (!data || !Array.isArray(data)) {
      return { rows: [], error: null };
    }
    const rows = (data as Record<string, unknown>[]).map((row) =>
      this.mapChartRpcRowToReading(deviceId, row)
    );
    return { rows: this.applyOffsetsToReadings(rows, this.snapshot), error: null };
  }

  /** Mapea filas del RPC get_device_readings_chart (incl. crudos si existen en la nube). */
  private mapChartRpcRowToReading(deviceId: string, row: Record<string, unknown>): TemperatureReading {
    const num = (k: string): number | null => {
      const v = row[k];
      return typeof v === 'number' && !Number.isNaN(v) ? v : null;
    };
    const t1Raw = num('temp1_raw_c');
    const t2Raw = num('temp2_raw_c');
    const t3Raw = num('temp3_raw_c');
    const t1 = num('temp1_c');
    return {
      deviceId,
      at: typeof row['read_at'] === 'string' ? row['read_at'] : new Date().toISOString(),
      temperatureC: t1 ?? 0,
      temp1RawC: t1Raw,
      temp2RawC: t2Raw,
      temp3RawC: t3Raw,
      temp2C: num('temp2_c'),
      temp3C: num('temp3_c'),
      currentA: num('current_a'),
      powerW: num('power_w'),
      currentARaw: num('current_a_raw'),
      powerWRaw: num('power_w_raw'),
    };
  }

  /**
   * Lecturas **crudas** en el rango (sin agregar por hora/día).
   * El RPC `get_device_readings_chart` agrupa si el rango supera 4 días; el PDF debe listar lecturas reales.
   */
  async fetchRawReadingsForPdfExport(
    deviceId: string,
    fromIso: string,
    toIso: string,
    maxRows = 20000
  ): Promise<{ rows: TemperatureReading[]; error: string | null; truncated: boolean }> {
    if (!this.isCloudSyncEnabled() || !this.isUuid(deviceId)) {
      return { rows: [], error: null, truncated: false };
    }
    const pageSize = 1000;
    const rows: TemperatureReading[] = [];
    let offset = 0;
    let lastBatchLen = 0;

    while (rows.length < maxRows) {
      const { data, error } = await this.auth.client
        .from('device_readings')
        .select(
          'created_at, temp1_c, temp2_c, temp3_c, temp1_raw_c, temp2_raw_c, temp3_raw_c, current_a, power_w, current_a_raw, power_w_raw'
        )
        .eq('device_id', deviceId)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.warn('device_readings pdf export:', error.message);
        return { rows, error: error.message, truncated: false };
      }

      const batch = (data as Record<string, unknown>[] | null) ?? [];
      lastBatchLen = batch.length;
      if (!batch.length) {
        break;
      }

      for (const row of batch) {
        if (rows.length >= maxRows) {
          break;
        }
        const t1Raw =
          typeof row['temp1_raw_c'] === 'number' && !Number.isNaN(row['temp1_raw_c'] as number)
            ? (row['temp1_raw_c'] as number)
            : null;
        const t2Raw =
          typeof row['temp2_raw_c'] === 'number' && !Number.isNaN(row['temp2_raw_c'] as number)
            ? (row['temp2_raw_c'] as number)
            : null;
        const t3Raw =
          typeof row['temp3_raw_c'] === 'number' && !Number.isNaN(row['temp3_raw_c'] as number)
            ? (row['temp3_raw_c'] as number)
            : null;
        rows.push({
          deviceId,
          at: typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString(),
          temperatureC: row['temp1_c'] as number,
          temp1RawC: t1Raw,
          temp2RawC: t2Raw,
          temp3RawC: t3Raw,
          temp2C:
            typeof row['temp2_c'] === 'number' && !Number.isNaN(row['temp2_c'] as number)
              ? (row['temp2_c'] as number)
              : null,
          temp3C:
            typeof row['temp3_c'] === 'number' && !Number.isNaN(row['temp3_c'] as number)
              ? (row['temp3_c'] as number)
              : null,
          currentA:
            typeof row['current_a'] === 'number' && !Number.isNaN(row['current_a'] as number)
              ? (row['current_a'] as number)
              : null,
          powerW:
            typeof row['power_w'] === 'number' && !Number.isNaN(row['power_w'] as number)
              ? (row['power_w'] as number)
              : null,
          currentARaw:
            typeof row['current_a_raw'] === 'number' && !Number.isNaN(row['current_a_raw'] as number)
              ? (row['current_a_raw'] as number)
              : null,
          powerWRaw:
            typeof row['power_w_raw'] === 'number' && !Number.isNaN(row['power_w_raw'] as number)
              ? (row['power_w_raw'] as number)
              : null,
        });
      }

      if (rows.length >= maxRows || lastBatchLen < pageSize) {
        break;
      }
      offset += lastBatchLen;
    }

    const truncated = rows.length >= maxRows && lastBatchLen === pageSize;
    const applied = this.applyOffsetsToReadings(rows, this.snapshot);
    return { rows: applied, error: null, truncated };
  }

  /**
   * Sin RPC: lecturas crudas en el rango.
   * Trae mitad del inicio + mitad del final para representar mejor rangos largos.
   * Sirve si aún no ejecutaste 003_chart_readings_range.sql en Supabase.
   */
  private async fetchChartReadingsForRangeDirect(
    deviceId: string,
    fromIso: string,
    toIso: string
  ): Promise<{ rows: TemperatureReading[]; error: string | null }> {
    const half = 10000;
    const base = this.auth.client
      .from('device_readings')
      .select(
        'created_at, temp1_c, temp2_c, temp3_c, temp1_raw_c, temp2_raw_c, temp3_raw_c, current_a, power_w, current_a_raw, power_w_raw'
      )
      .eq('device_id', deviceId)
      .gte('created_at', fromIso)
      .lte('created_at', toIso);

    const [{ data: dataAsc, error: errAsc }, { data: dataDesc, error: errDesc }] = await Promise.all([
      base.order('created_at', { ascending: true }).limit(half),
      base.order('created_at', { ascending: false }).limit(half),
    ]);

    const err = errAsc ?? errDesc;
    if (err) {
      console.warn('device_readings range:', err.message);
      return { rows: [], error: err.message };
    }

    const merged = [
      ...((dataAsc as Record<string, unknown>[] | null) ?? []),
      ...((dataDesc as Record<string, unknown>[] | null) ?? []),
    ];
    if (!merged.length) {
      return { rows: [], error: null };
    }

    const byAt = new Map<string, Record<string, unknown>>();
    for (const row of merged) {
      const at = typeof row['created_at'] === 'string' ? row['created_at'] : '';
      if (!at) continue;
      byAt.set(at, row);
    }

    const rows: TemperatureReading[] = [...byAt.values()]
      .map((row: Record<string, unknown>) => {
        const t1Raw =
          typeof row['temp1_raw_c'] === 'number' && !Number.isNaN(row['temp1_raw_c'] as number)
            ? (row['temp1_raw_c'] as number)
            : null;
        const t2Raw =
          typeof row['temp2_raw_c'] === 'number' && !Number.isNaN(row['temp2_raw_c'] as number)
            ? (row['temp2_raw_c'] as number)
            : null;
        const t3Raw =
          typeof row['temp3_raw_c'] === 'number' && !Number.isNaN(row['temp3_raw_c'] as number)
            ? (row['temp3_raw_c'] as number)
            : null;
        return {
          deviceId,
          at: typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString(),
          temperatureC: row['temp1_c'] as number,
          temp1RawC: t1Raw,
          temp2RawC: t2Raw,
          temp3RawC: t3Raw,
          temp2C:
            typeof row['temp2_c'] === 'number' && !Number.isNaN(row['temp2_c'] as number)
              ? (row['temp2_c'] as number)
              : null,
          temp3C:
            typeof row['temp3_c'] === 'number' && !Number.isNaN(row['temp3_c'] as number)
              ? (row['temp3_c'] as number)
              : null,
          currentA:
            typeof row['current_a'] === 'number' && !Number.isNaN(row['current_a'] as number)
              ? (row['current_a'] as number)
              : null,
          powerW:
            typeof row['power_w'] === 'number' && !Number.isNaN(row['power_w'] as number)
              ? (row['power_w'] as number)
              : null,
          currentARaw:
            typeof row['current_a_raw'] === 'number' && !Number.isNaN(row['current_a_raw'] as number)
              ? (row['current_a_raw'] as number)
              : null,
          powerWRaw:
            typeof row['power_w_raw'] === 'number' && !Number.isNaN(row['power_w_raw'] as number)
              ? (row['power_w_raw'] as number)
              : null,
        };
      })
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return { rows: this.applyOffsetsToReadings(rows, this.snapshot), error: null };
  }

  private isChartRpcMissingError(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes('could not find the function') ||
      m.includes('schema cache') ||
      m.includes('does not exist')
    );
  }

  private formatChartRpcError(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('could not find the function') || m.includes('does not exist')) {
      return (
        'Supabase no expone la función get_device_readings_chart. ' +
        'En el panel: SQL → pegá y ejecutá el archivo FRONTEND/supabase/sql/003_chart_readings_range.sql ' +
        '(al final incluye NOTIFY para refrescar la API). ' +
        'Mientras tanto la app intenta cargar lecturas sin esa función (hasta 20.000 puntos). ' +
        `Detalle técnico: ${message}`
      );
    }
    if (m.includes('not authorized') || m.includes('42501') || m.includes('permission denied')) {
      return (
        'No tenés permiso para leer ese dispositivo (sesión o dueño del equipo). ' +
        `Detalle: ${message}`
      );
    }
    return message;
  }

  private randomHex(byteLen: number): string {
    const arr = new Uint8Array(byteLen);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  private randomModuleId(): string {
    return `MOD-${this.randomHex(4)}`;
  }

  /** Código numérico de 6 dígitos para cargar en el ESP (WiFiManager: api_key). */
  private randomSixDigitToken(): string {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    let s = '';
    for (let i = 0; i < 6; i++) s += String(a[i] % 10);
    return s;
  }

  private async deviceTokenInUseInCloud(token: string): Promise<boolean> {
    const { data } = await this.auth.client
      .from('devices')
      .select('id')
      .eq('device_token_hash', token)
      .maybeSingle();
    return data != null;
  }

  private async randomDeviceTokenAsync(): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const t = this.randomSixDigitToken();
      if (!(await this.deviceTokenInUseInCloud(t))) return t;
    }
    return this.randomSixDigitToken();
  }

  private async moduleExistsInSupabase(moduleId: string): Promise<boolean> {
    const { data } = await this.auth.client
      .from('devices')
      .select('id')
      .eq('module_id', moduleId)
      .maybeSingle();
    return data != null;
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

  private async hydrateFromCloud(): Promise<void> {
    if (!this.isCloudSyncEnabled()) return;
    const session = await this.auth.getSession();
    if (!session?.user.id) return;

    const isAdmin = await this.auth.fetchIsAppAdmin();
    this.adminSubject.next(isAdmin);

    const baseFields =
      'id, module_id, name, location, active, updated_at, sensor_1_label, sensor_2_label';
    const selectFields = isAdmin ? `${baseFields}, owner_user_id` : baseFields;

    let q = this.auth.client
      .from('devices')
      .select(selectFields)
      .order('created_at', { ascending: true });
    if (!isAdmin) {
      q = q.eq('owner_user_id', session.user.id);
    }

    const { data, error } = await q;

    if (error || !data) {
      console.warn('Supabase devices:', error?.message);
      return;
    }

    type DeviceRow = {
      id: string;
      name: string;
      location: string | null;
      module_id: string;
      sensor_1_label: string | null;
      sensor_2_label: string | null;
      owner_user_id?: string | null;
    };
    const rows = data as unknown as DeviceRow[];

    const ids = rows.map((r) => r.id);
    const thresholdsByDevice = new Map<
      string,
      {
        enabled: boolean;
        low: number | null;
        high: number | null;
        low2: number | null;
        high2: number | null;
        currentMax: number | null;
        nominalVoltage: number;
        cooldownMs: number | null;
        offlineCooldownMs: number | null;
        o1: number;
        o2: number;
        o3: number;
        oA: number;
        oP: number;
      }
    >();
    if (ids.length) {
      const { data: thData } = await this.auth.client
        .from('device_thresholds')
        .select(
          'device_id, notifications_enabled, temp1_min_c, temp1_max_c, temp2_min_c, temp2_max_c, current_max_a, nominal_voltage_v, temp_push_cooldown_ms, offline_push_cooldown_ms, temp1_offset_c, temp2_offset_c, temp3_offset_c, current_offset_a, power_offset_w'
        )
        .in('device_id', ids);
      for (const th of (thData ?? []) as Record<string, unknown>[]) {
        const did = th['device_id'];
        if (typeof did !== 'string') continue;
        const off = (k: string) =>
          typeof th[k] === 'number' && !Number.isNaN(th[k] as number) ? (th[k] as number) : 0;
        const low1 =
          typeof th['temp1_min_c'] === 'number' && !Number.isNaN(th['temp1_min_c'] as number)
            ? (th['temp1_min_c'] as number)
            : null;
        const high1 =
          typeof th['temp1_max_c'] === 'number' && !Number.isNaN(th['temp1_max_c'] as number)
            ? (th['temp1_max_c'] as number)
            : null;
        const low2 =
          typeof th['temp2_min_c'] === 'number' && !Number.isNaN(th['temp2_min_c'] as number)
            ? (th['temp2_min_c'] as number)
            : null;
        const high2 =
          typeof th['temp2_max_c'] === 'number' && !Number.isNaN(th['temp2_max_c'] as number)
            ? (th['temp2_max_c'] as number)
            : null;
        thresholdsByDevice.set(did, {
          enabled: th['notifications_enabled'] !== false,
          low: low1,
          high: high1,
          low2,
          high2,
          currentMax:
            typeof th['current_max_a'] === 'number' && !Number.isNaN(th['current_max_a'] as number)
              ? (th['current_max_a'] as number)
              : null,
          nominalVoltage:
            typeof th['nominal_voltage_v'] === 'number' &&
            !Number.isNaN(th['nominal_voltage_v'] as number) &&
            (th['nominal_voltage_v'] as number) > 0
              ? (th['nominal_voltage_v'] as number)
              : 220,
          cooldownMs:
            typeof th['temp_push_cooldown_ms'] === 'number' &&
            !Number.isNaN(th['temp_push_cooldown_ms'] as number)
              ? Math.max(60 * 1000, Math.round(th['temp_push_cooldown_ms'] as number))
              : null,
          offlineCooldownMs:
            typeof th['offline_push_cooldown_ms'] === 'number' &&
            !Number.isNaN(th['offline_push_cooldown_ms'] as number)
              ? Math.max(60 * 1000, Math.round(th['offline_push_cooldown_ms'] as number))
              : null,
          o1: off('temp1_offset_c'),
          o2: off('temp2_offset_c'),
          o3: off('temp3_offset_c'),
          oA: off('current_offset_a'),
          oP: off('power_offset_w'),
        });
      }
    }

    const tokens = this.readTokenMap();
    const prevById = new Map(this.snapshot.map((d) => [d.id, d]));
    const cloudDevices: DashboardDevice[] = rows.map((row) => {
      const rid = row.id;
      const prev = prevById.get(rid);
      const th = thresholdsByDevice.get(rid);
      const s1 = row.sensor_1_label as string | null | undefined;
      const s2 = row.sensor_2_label as string | null | undefined;
      const ownerId =
        isAdmin && typeof row.owner_user_id === 'string' ? row.owner_user_id : undefined;
      return {
        id: rid,
        name: row.name,
        location: (row.location as string)?.trim() || 'Sin ubicación',
        moduleId: row.module_id,
        ownerUserId: ownerId,
        temperatureC: prev?.temperatureC ?? null,
        temperature2C: prev?.temperature2C ?? null,
        online: prev?.online ?? false,
        updatedAtLabel: prev?.updatedAtLabel ?? '—',
        batteryPct: prev?.batteryPct ?? null,
        espLocalIp: prev?.espLocalIp,
        alertsEnabled: th?.enabled ?? (prev?.alertsEnabled !== false),
        tempLowC: th?.low ?? (prev?.tempLowC ?? 2),
        tempHighC: th?.high ?? (prev?.tempHighC ?? 8),
        temp2LowC:
          th != null ? th.low2 : (prev?.temp2LowC ?? prev?.tempLowC ?? 2),
        temp2HighC:
          th != null ? th.high2 : (prev?.temp2HighC ?? prev?.tempHighC ?? 8),
        currentMaxA: th?.currentMax ?? prev?.currentMaxA ?? null,
        nominalVoltageV: th?.nominalVoltage ?? prev?.nominalVoltageV ?? 220,
        currentA: prev?.currentA ?? null,
        powerW: prev?.powerW ?? null,
        tempPushCooldownMs: th?.cooldownMs ?? (prev?.tempPushCooldownMs ?? 15 * 60 * 1000),
        offlinePushCooldownMs:
          th?.offlineCooldownMs ??
          th?.cooldownMs ??
          prev?.offlinePushCooldownMs ??
          prev?.tempPushCooldownMs ??
          15 * 60 * 1000,
        cloudSynced: true,
        deviceToken: tokens[rid] ?? prev?.deviceToken,
        sensor1Label:
          typeof s1 === 'string' && s1.trim()
            ? s1.trim()
            : prev?.sensor1Label ?? DEFAULT_SENSOR_1_LABEL,
        sensor2Label:
          typeof s2 === 'string' && s2.trim()
            ? s2.trim()
            : prev?.sensor2Label ?? DEFAULT_SENSOR_2_LABEL,
        temp1OffsetC: th?.o1 ?? prev?.temp1OffsetC ?? 0,
        temp2OffsetC: th?.o2 ?? prev?.temp2OffsetC ?? 0,
        temp3OffsetC: th?.o3 ?? prev?.temp3OffsetC ?? 0,
        currentOffsetA: th?.oA ?? prev?.currentOffsetA ?? 0,
        powerOffsetW: th?.oP ?? prev?.powerOffsetW ?? 0,
      };
    });

    const locals = this.snapshot.filter((d) => !this.isUuid(d.id));
    this.persistDevices([...locals, ...cloudDevices]);
    await this.refreshReadingsFromCloud();
  }

  /**
   * Si la lectura trae bruto del ESP (tempNRawC), el valor mostrado = bruto + offset actual del dispositivo.
   * Así al cambiar la corrección en el panel se actualiza la tarjeta sin esperar un nuevo POST del ESP.
   */
  private applyOffsetsToReadings(
    readings: TemperatureReading[],
    devices: DashboardDevice[]
  ): TemperatureReading[] {
    const byId = new Map(devices.map((d) => [d.id, d]));
    return readings.map((r) => {
      const d = byId.get(r.deviceId);
      if (!d) return r;
      const o1 = Number.isFinite(d.temp1OffsetC ?? NaN) ? (d.temp1OffsetC as number) : 0;
      const o2 = Number.isFinite(d.temp2OffsetC ?? NaN) ? (d.temp2OffsetC as number) : 0;
      const o3 = Number.isFinite(d.temp3OffsetC ?? NaN) ? (d.temp3OffsetC as number) : 0;
      const oA = Number.isFinite(d.currentOffsetA ?? NaN) ? (d.currentOffsetA as number) : 0;
      const oP = Number.isFinite(d.powerOffsetW ?? NaN) ? (d.powerOffsetW as number) : 0;
      let t1 = r.temperatureC;
      let t2 = r.temp2C ?? null;
      let t3 = r.temp3C ?? null;
      let ca = r.currentA ?? null;
      let pw = r.powerW ?? null;
      if (r.temp1RawC != null && Number.isFinite(r.temp1RawC)) {
        t1 = r.temp1RawC + o1;
      }
      if (r.temp2RawC != null && Number.isFinite(r.temp2RawC)) {
        t2 = r.temp2RawC + o2;
      }
      if (r.temp3RawC != null && Number.isFinite(r.temp3RawC)) {
        t3 = r.temp3RawC + o3;
      }
      if (r.currentARaw != null && Number.isFinite(r.currentARaw)) {
        ca = r.currentARaw + oA;
      }
      if (r.powerWRaw != null && Number.isFinite(r.powerWRaw)) {
        pw = r.powerWRaw + oP;
      }
      return { ...r, temperatureC: t1, temp2C: t2, temp3C: t3, currentA: ca, powerW: pw };
    });
  }

  private updateDeviceSnapshotsFromReadings(allReadings: TemperatureReading[]): void {
    const nowMs = Date.now();
    const offlineAfterMs =
      typeof environment.deviceOfflineAfterMs === 'number' && environment.deviceOfflineAfterMs > 0
        ? environment.deviceOfflineAfterMs
        : 90000;

    const latest = new Map<string, TemperatureReading>();
    const sorted = [...allReadings].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
    );
    for (let i = sorted.length - 1; i >= 0; i--) {
      const r = sorted[i];
      if (!this.isUuid(r.deviceId)) continue;
      if (!latest.has(r.deviceId)) latest.set(r.deviceId, r);
    }

    const updated = this.snapshot.map((d) => {
      const r = latest.get(d.id);
      if (!r) {
        if (this.isUuid(d.id)) {
          return { ...d, online: false };
        }
        return d;
      }
      const atMs = new Date(r.at).getTime();
      const isOnline = Number.isFinite(atMs) ? nowMs - atMs <= offlineAfterMs : false;
      return {
        ...d,
        temperatureC: r.temperatureC,
        temperature2C: r.temp2C ?? null,
        currentA: r.currentA ?? null,
        powerW: r.powerW ?? null,
        online: isOnline,
        updatedAtLabel: this.formatUpdatedLabel(r.at),
      };
    });
    this.persistDevices(updated);
  }

  private recomputeReadingsDisplayTemps(): void {
    const applied = this.applyOffsetsToReadings(this.readingsSnapshot, this.snapshot);
    this.persistReadings(applied);
    this.updateDeviceSnapshotsFromReadings(applied);
  }

  private async refreshReadingsFromCloud(): Promise<void> {
    if (!this.isCloudSyncEnabled()) return;
    const ids = this.snapshot.filter((d) => this.isUuid(d.id)).map((d) => d.id);
    if (!ids.length) return;

    const selectCols =
      'device_id, created_at, temp1_c, temp2_c, temp3_c, temp1_raw_c, temp2_raw_c, temp3_raw_c, current_a, power_w, current_a_raw, power_w_raw, press1_bar, press2_bar';
    const rows: Record<string, unknown>[] = [];

    for (const deviceId of ids) {
      const { data, error } = await this.auth.client
        .from('device_readings')
        .select(selectCols)
        .eq('device_id', deviceId)
        .order('created_at', { ascending: false })
        .limit(CLOUD_READINGS_PER_DEVICE);

      if (error) {
        console.warn('Supabase readings:', error.message);
        continue;
      }
      if (data?.length) rows.push(...data);
    }

    if (!rows.length) return;

    const cloudReadings: TemperatureReading[] = rows.map((r) => {
      const t1Raw =
        typeof r['temp1_raw_c'] === 'number' && !Number.isNaN(r['temp1_raw_c'] as number)
          ? (r['temp1_raw_c'] as number)
          : null;
      const t2Raw =
        typeof r['temp2_raw_c'] === 'number' && !Number.isNaN(r['temp2_raw_c'] as number)
          ? (r['temp2_raw_c'] as number)
          : null;
      const t3Raw =
        typeof r['temp3_raw_c'] === 'number' && !Number.isNaN(r['temp3_raw_c'] as number)
          ? (r['temp3_raw_c'] as number)
          : null;
      return {
        deviceId: r['device_id'] as string,
        at: r['created_at'] as string,
        temperatureC: r['temp1_c'] as number,
        temp1RawC: t1Raw,
        temp2RawC: t2Raw,
        temp3RawC: t3Raw,
        temp2C:
          typeof r['temp2_c'] === 'number' && !Number.isNaN(r['temp2_c'] as number)
            ? (r['temp2_c'] as number)
            : null,
        temp3C:
          typeof r['temp3_c'] === 'number' && !Number.isNaN(r['temp3_c'] as number)
            ? (r['temp3_c'] as number)
            : null,
        currentA:
          typeof r['current_a'] === 'number' && !Number.isNaN(r['current_a'] as number)
            ? (r['current_a'] as number)
            : null,
        powerW:
          typeof r['power_w'] === 'number' && !Number.isNaN(r['power_w'] as number)
            ? (r['power_w'] as number)
            : null,
        currentARaw:
          typeof r['current_a_raw'] === 'number' && !Number.isNaN(r['current_a_raw'] as number)
            ? (r['current_a_raw'] as number)
            : null,
        powerWRaw:
          typeof r['power_w_raw'] === 'number' && !Number.isNaN(r['power_w_raw'] as number)
            ? (r['power_w_raw'] as number)
            : null,
        press1Bar:
          typeof r['press1_bar'] === 'number' && !Number.isNaN(r['press1_bar'] as number)
            ? (r['press1_bar'] as number)
            : null,
        press2Bar:
          typeof r['press2_bar'] === 'number' && !Number.isNaN(r['press2_bar'] as number)
            ? (r['press2_bar'] as number)
            : null,
      };
    });

    cloudReadings.sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
    );

    const localReadings = this.readingsSnapshot.filter((r) => !this.isUuid(r.deviceId));
    const merged = [...localReadings, ...cloudReadings];
    const applied = this.applyOffsetsToReadings(merged, this.snapshot);
    this.persistReadings(applied);
    this.updateDeviceSnapshotsFromReadings(applied);
  }

  setDevices(list: DashboardDevice[]): void {
    this.persistDevices([...list]);
  }

  loadSampleDevices(): void {
    if (this.isCloudSyncEnabled()) {
      return;
    }
    this.persistDevices(DASHBOARD_SAMPLE_DEVICES);
    const synthetic: TemperatureReading[] = [];
    const now = new Date();
    for (let day = 6; day >= 0; day--) {
      for (const dev of DASHBOARD_SAMPLE_DEVICES) {
        const t = new Date(now);
        t.setHours(0, 0, 0, 0);
        t.setDate(t.getDate() - day);
        t.setHours(10 + (day % 4), 30, 0, 0);
        const base = dev.temperatureC ?? 3;
        synthetic.push({
          deviceId: dev.id,
          at: t.toISOString(),
          temperatureC:
            Math.round((base + Math.sin(day * 0.7) * 0.5 + (dev.id.charCodeAt(0) % 5) * 0.1) * 10) /
            10,
          temp2C:
            Math.round((base + Math.cos(day * 0.6) * 0.4 + 0.2) * 10) / 10,
          temp3C:
            Math.round((base + Math.sin(day * 0.5) * 0.3 - 0.3) * 10) / 10,
          currentA:
            Math.round((2.1 + (dev.id.charCodeAt(1) % 10) * 0.35 + Math.sin(day) * 0.4) * 100) / 100,
          powerW:
            Math.round((160 + (dev.id.charCodeAt(1) % 12) * 8 + Math.sin(day) * 18) * 10) / 10,
          press1Bar:
            Math.round((2.1 + Math.sin(day * 0.4) * 0.12) * 100) / 100,
          press2Bar:
            Math.round((2.2 + Math.cos(day * 0.4) * 0.09) * 100) / 100,
        });
      }
    }
    this.persistReadings(synthetic);
  }

  clearDevices(): void {
    this.persistDevices([]);
    this.persistReadings([]);
  }

  /**
   * Con nube: borra en Supabase y solo entonces quita local + lecturas.
   * Si el DELETE falla (red, RLS, etc.), la lista local no cambia.
   */
  async removeDeviceAsync(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.isCloudSyncEnabled() && this.isUuid(id)) {
      const { error } = await this.auth.client.from('devices').delete().eq('id', id);
      if (error) {
        return { ok: false, error: error.message };
      }
      this.removeDeviceToken(id);
    }
    this.persistDevices(this.snapshot.filter((d) => d.id !== id));
    this.persistReadings(this.readingsSnapshot.filter((r) => r.deviceId !== id));
    return { ok: true };
  }

  async updateDeviceMeta(
    id: string,
    input: { name: string; location: string; moduleId: string; espLocalIp: string }
  ): Promise<{ ok: boolean; error?: string }> {
    const name = input.name.trim();
    const location = input.location.trim() || 'Sin ubicación';
    const moduleId = input.moduleId.trim();
    const espLocalIp = input.espLocalIp.trim();
    const current = this.snapshot.find((d) => d.id === id);
    const moduleForDb = moduleId || current?.moduleId;

    if (this.isCloudSyncEnabled() && this.isUuid(id)) {
      const patch: Record<string, unknown> = { name, location };
      if (moduleForDb) {
        patch['module_id'] = moduleForDb;
      }
      const { error } = await this.auth.client
        .from('devices')
        .update(patch)
        .eq('id', id);
      if (error) {
        return { ok: false, error: error.message };
      }
    }

    this.persistDevices(
      this.snapshot.map((d) =>
        d.id === id
          ? {
              ...d,
              name,
              location,
              moduleId: moduleForDb || undefined,
              espLocalIp: espLocalIp || undefined,
            }
          : d
      )
    );
    return { ok: true };
  }

  /**
   * Guarda nombres de sensores en local y, si aplica, en Supabase.
   * Si falla la nube, igual se persiste local y el caller puede avisar.
   */
  async updateDeviceSensorLabels(
    id: string,
    sensor1Label: string,
    sensor2Label: string
  ): Promise<{ cloudError?: string }> {
    const s1 = sensor1Label.trim() || DEFAULT_SENSOR_1_LABEL;
    const s2 = sensor2Label.trim() || DEFAULT_SENSOR_2_LABEL;
    let cloudError: string | undefined;
    if (this.isCloudSyncEnabled() && this.isUuid(id)) {
      const { error } = await this.auth.client
        .from('devices')
        .update({ sensor_1_label: s1, sensor_2_label: s2 })
        .eq('id', id);
      if (error) {
        cloudError = error.message;
      }
    }
    this.persistDevices(
      this.snapshot.map((d) =>
        d.id === id ? { ...d, sensor1Label: s1, sensor2Label: s2 } : d
      )
    );
    return { cloudError };
  }

  async updateDeviceNotificationConfig(
    id: string,
    input: DeviceNotificationConfigInput
  ): Promise<{ cloudError?: string }> {
    const low = input.tempLowC;
    const high = input.tempHighC;
    const low2 = input.temp2LowC;
    const high2 = input.temp2HighC;
    const currentMaxA = input.currentMaxA;
    const nominalV =
      input.nominalVoltageV != null &&
      Number.isFinite(input.nominalVoltageV) &&
      input.nominalVoltageV > 0
        ? input.nominalVoltageV
        : 220;
    let cloudError: string | undefined;
    if (this.isCloudSyncEnabled() && this.isUuid(id)) {
      const nowIso = new Date().toISOString();
        const { error } = await this.auth.client
        .from('device_thresholds')
        .upsert(
          {
            device_id: id,
            notifications_enabled: input.alertsEnabled,
            temp1_min_c: low,
            temp1_max_c: high,
            temp2_min_c: low2,
            temp2_max_c: high2,
            current_max_a: currentMaxA,
            nominal_voltage_v: nominalV,
            temp_push_cooldown_ms: input.tempPushCooldownMs,
            offline_push_cooldown_ms: input.offlinePushCooldownMs,
            updated_at: nowIso,
          },
          { onConflict: 'device_id' }
        );
      if (error) {
        cloudError = error.message;
      }
    }
    this.persistDevices(
      this.snapshot.map((d) =>
        d.id === id
          ? {
              ...d,
              alertsEnabled: input.alertsEnabled,
              tempLowC: low,
              tempHighC: high,
              temp2LowC: low2,
              temp2HighC: high2,
              currentMaxA,
              nominalVoltageV: nominalV,
              tempPushCooldownMs: input.tempPushCooldownMs,
              offlinePushCooldownMs: input.offlinePushCooldownMs,
            }
          : d
      )
    );
    return { cloudError };
  }

  /**
   * Energía (kWh) en un rango de tiempo (integración trapezoidal en servidor; requiere SQL 019).
   */
  async fetchDeviceEnergyKwh(
    deviceId: string,
    fromIso: string,
    toIso: string
  ): Promise<{ kwh: number | null; error?: string }> {
    if (!this.isCloudSyncEnabled() || !this.isUuid(deviceId)) {
      return { kwh: null, error: 'Solo disponible con dispositivos en la nube.' };
    }
    const { data, error } = await this.auth.client.rpc('get_device_energy_kwh', {
      p_device_id: deviceId,
      p_from: fromIso,
      p_to: toIso,
    });
    if (error) {
      return { kwh: null, error: error.message };
    }
    const n = typeof data === 'number' ? data : Number(data);
    if (!Number.isFinite(n)) {
      return { kwh: null, error: 'Respuesta inválida del servidor.' };
    }
    return { kwh: n };
  }

  async updateDeviceTempCalibration(
    id: string,
    input: DeviceTempCalibrationInput
  ): Promise<{ cloudError?: string }> {
    let cloudError: string | undefined;
    const dev = this.snapshot.find((d) => d.id === id);
    if (this.isCloudSyncEnabled() && this.isUuid(id)) {
      const nowIso = new Date().toISOString();
      // Si ya hay fila: solo offsets (no pisar min/máx con null). Si no hay fila: insert con defaults.
      const { data: existing, error: selErr } = await this.auth.client
        .from('device_thresholds')
        .select('device_id')
        .eq('device_id', id)
        .maybeSingle();

      if (selErr) {
        cloudError = selErr.message;
      } else if (existing) {
        const { error } = await this.auth.client
          .from('device_thresholds')
          .update({
            temp1_offset_c: input.temp1OffsetC,
            temp2_offset_c: input.temp2OffsetC,
            temp3_offset_c: input.temp3OffsetC,
            current_offset_a: input.currentOffsetA,
            power_offset_w: input.powerOffsetW,
            updated_at: nowIso,
          })
          .eq('device_id', id);
        if (error) {
          cloudError = error.message;
        }
      } else {
        const insertPayload = {
          device_id: id,
          notifications_enabled: dev?.alertsEnabled !== false,
          temp1_min_c: dev?.tempLowC ?? null,
          temp1_max_c: dev?.tempHighC ?? null,
          temp2_min_c: dev?.temp2LowC ?? dev?.tempLowC ?? null,
          temp2_max_c: dev?.temp2HighC ?? dev?.tempHighC ?? null,
          current_max_a: dev?.currentMaxA ?? null,
          nominal_voltage_v:
            dev?.nominalVoltageV != null &&
            Number.isFinite(dev.nominalVoltageV) &&
            dev.nominalVoltageV > 0
              ? dev.nominalVoltageV
              : 220,
          temp_push_cooldown_ms: dev?.tempPushCooldownMs ?? 15 * 60 * 1000,
          offline_push_cooldown_ms:
            dev?.offlinePushCooldownMs ?? dev?.tempPushCooldownMs ?? 15 * 60 * 1000,
          temp1_offset_c: input.temp1OffsetC,
          temp2_offset_c: input.temp2OffsetC,
          temp3_offset_c: input.temp3OffsetC,
          current_offset_a: input.currentOffsetA,
          power_offset_w: input.powerOffsetW,
          updated_at: nowIso,
        };
        const { error: insErr } = await this.auth.client
          .from('device_thresholds')
          .insert(insertPayload);
        if (insErr) {
          const dup =
            (insErr as { code?: string }).code === '23505' ||
            /duplicate|unique/i.test(insErr.message ?? '');
          if (dup) {
            const { error: upErr } = await this.auth.client
              .from('device_thresholds')
              .update({
                temp1_offset_c: input.temp1OffsetC,
                temp2_offset_c: input.temp2OffsetC,
                temp3_offset_c: input.temp3OffsetC,
                current_offset_a: input.currentOffsetA,
                power_offset_w: input.powerOffsetW,
                updated_at: nowIso,
              })
              .eq('device_id', id);
            if (upErr) {
              cloudError = upErr.message;
            }
          } else {
            cloudError = insErr.message;
          }
        }
      }
    }
    this.persistDevices(
      this.snapshot.map((d) =>
        d.id === id
          ? {
              ...d,
              temp1OffsetC: input.temp1OffsetC,
              temp2OffsetC: input.temp2OffsetC,
              temp3OffsetC: input.temp3OffsetC,
              currentOffsetA: input.currentOffsetA,
              powerOffsetW: input.powerOffsetW,
            }
          : d
      )
    );
    this.recomputeReadingsDisplayTemps();
    return { cloudError };
  }

  recordTemperatureReading(deviceId: string, temperatureC: number): void {
    if (Number.isNaN(temperatureC)) return;
    const device = this.snapshot.find((d) => d.id === deviceId);
    if (!device) return;
    const at = new Date().toISOString();
    const label = this.formatUpdatedLabel(at);
    this.persistDevices(
      this.snapshot.map((d) =>
        d.id === deviceId
          ? {
              ...d,
              temperatureC,
              temperature2C: d.temperature2C ?? null,
              online: true,
              updatedAtLabel: label,
            }
          : d
      )
    );
    const reading: TemperatureReading = { deviceId, at, temperatureC };
    this.persistReadings([...this.readingsSnapshot, reading]);
  }

  recordTelemetryReading(input: TelemetryInput): void {
    if (Number.isNaN(input.temp1C)) return;
    const device = this.snapshot.find((d) => d.id === input.deviceId);
    if (!device) return;
    const at = input.at ?? new Date().toISOString();
    const label = this.formatUpdatedLabel(at);
    const reading: TemperatureReading = {
      deviceId: input.deviceId,
      at,
      temperatureC: input.temp1C,
      temp1RawC: input.temp1C,
      temp2RawC: input.temp2C ?? null,
      temp3RawC: input.temp3C ?? null,
      temp2C: input.temp2C ?? null,
      temp3C: input.temp3C ?? null,
      currentARaw: input.currentA ?? null,
      powerWRaw: input.powerW ?? null,
      currentA: input.currentA ?? null,
      powerW: input.powerW ?? null,
      press1Bar: input.press1Bar ?? null,
      press2Bar: input.press2Bar ?? null,
    };
    const [applied] = this.applyOffsetsToReadings([reading], this.snapshot);
    this.persistDevices(
      this.snapshot.map((d) =>
        d.id === input.deviceId
          ? {
              ...d,
              temperatureC: applied.temperatureC,
              temperature2C: applied.temp2C ?? null,
              currentA: applied.currentA ?? null,
              powerW: applied.powerW ?? null,
              online: true,
              updatedAtLabel: label,
            }
          : d
      )
    );
    this.persistReadings([...this.readingsSnapshot, applied]);
  }

  private addDeviceFromFormLocal(
    name: string,
    location: string,
    moduleId: string,
    espLocalIp: string
  ): string {
    const baseId = moduleId
      ? moduleId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48)
      : `DEV-${Date.now().toString(36).toUpperCase()}`;

    let id = baseId || `DEV-${Date.now().toString(36).toUpperCase()}`;
    let n = 0;
    while (this.snapshot.some((d) => d.id === id)) {
      n += 1;
      id = `${baseId}-${n}`;
    }

    const device: DashboardDevice = {
      id,
      name,
      location,
      temperatureC: null,
      temperature2C: null,
      online: false,
      updatedAtLabel: 'Esperando dispositivo',
      batteryPct: null,
      moduleId: moduleId || undefined,
      espLocalIp: espLocalIp || undefined,
      alertsEnabled: true,
      tempLowC: 2,
      tempHighC: 8,
      temp2LowC: 2,
      temp2HighC: 8,
      currentMaxA: null,
      nominalVoltageV: 220,
      sensor1Label: DEFAULT_SENSOR_1_LABEL,
      sensor2Label: DEFAULT_SENSOR_2_LABEL,
      temp1OffsetC: 0,
      temp2OffsetC: 0,
      temp3OffsetC: 0,
      currentOffsetA: 0,
      powerOffsetW: 0,
    };

    this.persistDevices([...this.snapshot, device]);
    return id;
  }
}
