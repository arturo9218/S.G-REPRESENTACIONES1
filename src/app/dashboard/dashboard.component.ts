import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { combineLatest, fromEvent, Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { AuthService } from '../core/auth.service';
import { DeviceStoreService, DeviceTempCalibrationInput } from '../core/device-store.service';
import {
  ActivityItem,
  AlarmSoundPreset,
  ChartStylePreset,
  DashboardAlert,
  DashboardAlertKind,
  DashboardDevice,
  DeviceAlarmEvent,
  HistoryListItem,
  TemperatureReading,
} from '../core/models/dashboard.models';
import { environment } from '../../environments/environment';
import { WebPushService, WebPushUiState } from '../core/web-push.service';
import { effectiveCurrentAWithNominal } from '../core/reading.utils';
import {
  DeviceEquipmentFichaRow,
  DeviceEquipmentLogRow,
  DeviceEquipmentPhotoRow,
  EquipmentSheetService,
} from '../core/equipment-sheet.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  readonly isDev = !environment.production;
  /** Expuesto al template (intervalo de actualización de lecturas). */
  readonly environment = environment;

  /** Sin clave pública VAPID en el build, Web Push no puede registrarse (VAPID_PUBLIC_KEY en build / Vercel). */
  get webPushPublicKeyConfigured(): boolean {
    return typeof this.environment.vapidPublicKey === 'string' && this.environment.vapidPublicKey.trim().length > 0;
  }

  email: string | null = null;
  userInitial = '?';
  searchQuery = '';

  devices: DashboardDevice[] = [];
  readings: TemperatureReading[] = [];
  selectedDeviceId: string | null = null;
  alertsEnabledForm = true;
  tempLowForm = '';
  tempHighForm = '';
  temp2LowForm = '';
  temp2HighForm = '';
  /** Corriente máxima RMS (A); vacío = sin límite */
  currentMaxForm = '';
  /** Tensión nominal de línea (V), p. ej. 220 o 380 */
  nominalVoltageForm = '220';
  tempPushDelayMinForm = '15';
  /** Retardo entre avisos de “desconectado” (min), independiente del de temperatura */
  offlinePushDelayMinForm = '15';
  /** Suma en °C al valor del ESP (corrección por sensor); se aplica en la nube al guardar lecturas. */
  temp1OffsetForm = '0';
  temp2OffsetForm = '0';
  temp3OffsetForm = '0';
  /** Suma en A al valor de corriente (corrección por medición). */
  currentOffsetForm = '0';
  /** Suma en W al valor de potencia. */
  powerOffsetForm = '0';
  calibrationDirty = false;
  calibrationSaving = false;
  calibrationFeedback = '';
  sensor1LabelForm = '';
  sensor2LabelForm = '';
  sensorLabelsDirty = false;
  notificationSettingsDirty = false;
  /** Evita marcar el form como "dirty" cuando el polling rellena campos desde el dispositivo. */
  private syncingNotificationFormFromDevice = false;
  /** Igual que arriba, para offsets de corrección de temperatura. */
  private syncingCalibrationFromDevice = false;

  webPushUiState: WebPushUiState = 'loading';
  webPushBusy = false;
  webPushFeedback = '';
  webPushFeedbackIsError = false;
  sensorLabelsSaving = false;
  sensorLabelsFeedback = '';
  notificationSettingsSaving = false;
  notificationSettingsFeedback = '';
  notificationSettingsFeedbackIsError = false;
  /** Consumo aproximado del día (local), desde RPC get_device_energy_kwh (SQL 019). */
  dailyEnergyKwh: number | null = null;
  dailyEnergyLoading = false;
  dailyEnergyError = '';
  private subDev: Subscription | null = null;
  private subRead: Subscription | null = null;
  private subAdmin: Subscription | null = null;
  /** Vista admin: todos los equipos; permisos reales vienen de Supabase (admin_emails + is_app_admin). */
  isAdminView = false;
  /** Lista de emails admin (solo visible si isAdminView; tabla public.admin_emails). */
  adminListEmails: string[] = [];
  adminListLoading = false;
  adminListSaving = false;
  newAdminEmail = '';
  adminListFeedback = '';
  private routerSub: Subscription | null = null;
  private routeQuerySub: Subscription | null = null;
  private visibilitySub: Subscription | null = null;
  /** Evita que queryParamMap pise la selección mientras actualizamos la URL desde el picker */
  private skipQueryParamDeviceSync = false;
  private audioCtx: AudioContext | null = null;
  private unlockAudioHandler: (() => void) | null = null;

  /** null = cerrado; 'add' | 'edit' */
  deviceModalMode: 'add' | 'edit' | null = null;
  editingDeviceId: string | null = null;
  addDeviceSubmitting = false;

  /** Vista compacta vs ampliada del gráfico de temperaturas */
  chartExpanded = false;

  private readonly chartStyleStorageKey = 'ar_chart_style_v1';
  chartStylePreset: ChartStylePreset = 'area';
  readonly chartStyleOptions: { value: ChartStylePreset; label: string }[] = [
    { value: 'area', label: 'Área (relleno suave)' },
    { value: 'line', label: 'Solo líneas' },
    { value: 'minimal', label: 'Minimal (limpio)' },
    { value: 'technical', label: 'Técnico (rejilla)' },
    { value: 'trend', label: 'Tendencia (rejilla + color por subida/bajada)' },
  ];
  pdfExporting = false;
  /** Tope de filas en la tabla del PDF; si hay más lecturas en el rango, muestreo uniforme en todo el período. */
  private readonly pdfTableMaxRows = 4000;
  /** Rango para PDF (`yyyy-MM-dd`, vacío = sin límite en ese extremo). */
  pdfExportFromDate = '';
  pdfExportToDate = '';
  /**
   * Vista según la URL: panel principal, dispositivos, alertas o configuración.
   * Sidebar y barra móvil reflejan este valor (sincronizado en `syncShellRoute`).
   */
  shellRoute: 'dashboard' | 'devices' | 'equipment' | 'alerts' | 'settings' = 'dashboard';

  /** Ficha técnica / bitácora (solo nube + UUID). */
  equipmentLoading = false;
  equipmentSaving = false;
  equipmentFeedback = '';
  equipmentFichas: DeviceEquipmentFichaRow[] = [];
  selectedFichaId: string | null = null;
  equipmentLogRows: DeviceEquipmentLogRow[] = [];
  equipmentPhotos: DeviceEquipmentPhotoRow[] = [];
  eqFichaLabelForm = '';
  eqCompressorForm = '';
  eqHpForm = '';
  eqRefrigerantForm = '';
  eqCondenserCoolingForm = '';
  eqCondenserFanCountForm = '';
  eqCondenserBladeForm = '';
  eqCondenserFanPhasesForm = '';
  eqCondenserCapacitorForm = '';
  eqCondenserNotesForm = '';
  eqExpansionTypeForm = '';
  eqExpansionCapillaryForm = '';
  eqExpansionValveBrandForm = '';
  eqExpansionValveModelForm = '';
  eqEvapAirTypeForm = '';
  eqEvapFanCountForm = '';
  eqEvapFanPhasesForm = '';
  eqEvapSingleDetailForm = '';
  eqEvapNotesForm = '';
  eqSupplyForm = '';
  eqPumpDownForm = false;
  eqDefrostForm = '';
  eqChamberForm = '';
  eqFreeNotesForm = '';
  eqLastMaintDate = '';
  eqLastMaintTime = '';
  eqNextMaintDate = '';
  eqNextMaintTime = '';
  eqMaintIntervalForm = '';
  eqMaintNotifyForm = true;
  logNoteForm = '';
  logDateForm = '';
  logTimeForm = '';
  photoCaptionForm = '';
  /** Evita múltiples `loadEquipmentPage` seguidos (ruta + query + lista de equipos). */
  private equipmentPageReloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Solo reinicia la bitácora (fecha/nota) al cambiar de ficha o de equipo, no en cada recarga de lista. */
  private lastEquipmentLogFichaId: string | null = null;
  /** Tarjeta “Ficha guardada” (clic → scroll al formulario). */
  equipmentSavedCard: { label: string; at: string } | null = null;
  private equipmentSavedCardTimer: ReturnType<typeof setTimeout> | null = null;

  equipmentPdfExporting = false;
  /** Opciones del PDF de ficha: anexos de nube (últimos 7 días / historial cargado). */
  equipmentPdfIncludeAlarms = true;
  equipmentPdfIncludeReadings = true;
  /** Incluir imagen de gráfico (temp. / corriente) en el PDF de ficha. */
  equipmentPdfIncludeChart = false;
  /** Rango para el gráfico del PDF (`yyyy-MM-dd`, vacío = últimos 7 días). */
  equipmentPdfChartFromDate = '';
  equipmentPdfChartToDate = '';
  /** Mensaje breve al crear una ficha nueva desde el panel. */
  equipmentNewFichaHint = '';
  equipmentPhotoUploading = false;
  alarmEventsCount = 0;
  /** Registros en la nube (device_alarm_events); solo con sesión Supabase + SQL 013. */
  alarmHistoryItems: DeviceAlarmEvent[] = [];
  alarmHistoryLoading = false;
  alarmHistoryError = '';
  private lastAlarmHistoryLoadMs = 0;
  private lastActiveAlertIds = new Set<string>();
  private lastAlarmToneAtMs = 0;
  /** Primera pasada: persistir snapshot sin sonar (evita pitido al recargar con las mismas alertas). */
  private panelAlarmSnapshotInitialized = false;
  /** Primera hidratación con dispositivos: si no había snapshot, alinear sin pitido (evita “todas nuevas”). */
  private panelAlarmBaselineSeeded = false;
  /** Primera pasada con datos: ancla el repeat para no sonar al entrar si el último pitido fue hace mucho. */
  private alarmRepeatAnchorDone = false;
  /**
   * Tras recargar, la primera emisión suele ser con readings=[] → todos "offline" (ids `…-offline`).
   * Al llegar lecturas, los ids pasan a `…-crit`/etc. Sin re-alinear, suena como alerta nueva.
   */
  private readingsHydrationDone = false;
  /** No pitido del panel (ni notif. del navegador) hasta este instante; cubre carreras al cargar/recargar. */
  private alarmPanelSilentUntilMs = 0;
  private readonly panelAlertIdsStorageKey = 'ar_panel_alert_ids_v1';
  /** Último pitido del panel (ms); respeta el retardo entre alertas al reabrir la app */
  private readonly panelLastAlarmToneAtStorageKey = 'ar_panel_last_alarm_tone_at_v1';
  private readonly alarmsCountStorageKey = 'ar_alarms_count_v1';
  private readonly alarmSoundStorageKey = 'ar_alarm_sound_v1';

  /** Preset de pitido (panel y notificación en primer plano) */
  alarmSoundPreset: AlarmSoundPreset = 'classic';
  readonly alarmSoundOptions: { value: AlarmSoundPreset; label: string }[] = [
    { value: 'classic', label: 'Clásico (agudo)' },
    { value: 'buzzer', label: 'Buzzer (doble)' },
    { value: 'chime', label: 'Campanilla (3 notas)' },
    { value: 'low', label: 'Grave (suave)' },
  ];

  /** Tras crear en la nube: datos para WiFiManager del ESP */
  provisioningOpen = false;
  provisioningCredentials: { moduleId: string; deviceToken: string; ingestUrl: string } | null =
    null;

  readonly deviceForm = this.fb.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    location: ['', [Validators.maxLength(120)]],
    moduleId: ['', [Validators.maxLength(64)]],
    espLocalIp: ['', [Validators.maxLength(45)]],
    manualTemp: ['', [Validators.maxLength(10)]],
  });

  constructor(
    private readonly fb: FormBuilder,
    private readonly auth: AuthService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    readonly deviceStore: DeviceStoreService,
    private readonly webPush: WebPushService,
    private readonly equipmentSheet: EquipmentSheetService
  ) {
    void this.auth.getSession().then((s) => {
      this.email = s?.user.email ?? null;
      const mail = this.email ?? '';
      this.userInitial = mail ? mail.charAt(0).toUpperCase() : '?';
    });
  }

  ngOnInit(): void {
    this.alarmPanelSilentUntilMs = Date.now() + 10_000;
    this.syncShellRoute();
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.syncShellRoute());
    this.loadChartStylePreset();
    this.loadAlarmSoundPreset();
    void this.refreshWebPushUi();
    this.setupAlarmAudioUnlock();
    /** Al volver a la pestaña/app, el cooldown del pitido repetido no debe dispararse por el tiempo en segundo plano. */
    this.visibilitySub = fromEvent(document, 'visibilitychange').subscribe(() => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        this.lastAlarmToneAtMs = now;
        this.persistLastAlarmToneAtMs(now);
      }
    });
    this.alarmEventsCount = this.loadAlarmEventsCount();
    this.routeQuerySub = combineLatest([
      this.deviceStore.devices$,
      this.route.queryParamMap,
    ]).subscribe(([list, params]) => {
      if (this.skipQueryParamDeviceSync) {
        return;
      }
      const did = params.get('deviceId');
      if (did && list.some((d) => d.id === did)) {
        if (this.selectedDeviceId !== did) {
          this.selectDevice(did, false);
        }
      } else if (!this.selectedDeviceId && list.length > 0) {
        this.selectDevice(list[0].id, false);
      }
      // No recargar ficha en cada emisión de devices$ (provocaba bucle y borraba lo que escribías).
    });
    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.devices = list;
      if (this.selectedDeviceId && !list.some((d) => d.id === this.selectedDeviceId)) {
        this.selectDevice(list[0]?.id ?? null, false);
        return;
      }
      this.syncNotificationFormWithSelected();
      this.updateAlarmAccumulator();
      this.maybeRefreshAlarmHistoryThrottled();
    });
    this.subRead = this.deviceStore.readings$.subscribe((list) => {
      this.readings = list;
      this.updateAlarmAccumulator();
    });
    this.subAdmin = this.deviceStore.admin$.subscribe((v) => {
      this.isAdminView = v;
      if (v && this.shellRoute === 'settings') void this.loadAdminEmails();
    });
  }

  ngOnDestroy(): void {
    if (this.equipmentPageReloadTimer != null) {
      clearTimeout(this.equipmentPageReloadTimer);
      this.equipmentPageReloadTimer = null;
    }
    if (this.equipmentSavedCardTimer != null) {
      clearTimeout(this.equipmentSavedCardTimer);
      this.equipmentSavedCardTimer = null;
    }
    if (this.unlockAudioHandler) {
      window.removeEventListener('pointerdown', this.unlockAudioHandler);
      window.removeEventListener('keydown', this.unlockAudioHandler);
      this.unlockAudioHandler = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.subDev?.unsubscribe();
    this.subRead?.unsubscribe();
    this.subAdmin?.unsubscribe();
    this.routerSub?.unsubscribe();
    this.routeQuerySub?.unsubscribe();
    this.visibilitySub?.unsubscribe();
    this.visibilitySub = null;
  }

  private syncShellRoute(): void {
    const path = this.router.url.split('?')[0];
    if (path === '/configuracion') {
      this.shellRoute = 'settings';
      void this.refreshWebPushUi();
      if (this.isAdminView) void this.loadAdminEmails();
      return;
    }
    if (path === '/dispositivos') {
      this.shellRoute = 'devices';
      return;
    }
    if (path === '/ficha-equipo') {
      this.shellRoute = 'equipment';
      this.scheduleEquipmentPageReload();
      return;
    }
    if (path === '/alertas') {
      this.shellRoute = 'alerts';
      this.scheduleAlarmHistoryIfVisible();
      return;
    }
    if (path === '/dashboard') {
      this.shellRoute = 'dashboard';
    }
    this.scheduleAlarmHistoryIfVisible();
  }

  private scheduleAlarmHistoryIfVisible(): void {
    if (
      !this.deviceStore.isCloudSyncActive() ||
      (this.shellRoute !== 'dashboard' && this.shellRoute !== 'alerts')
    ) {
      return;
    }
    void this.loadAlarmHistory();
  }

  private maybeRefreshAlarmHistoryThrottled(): void {
    if (
      !this.deviceStore.isCloudSyncActive() ||
      (this.shellRoute !== 'dashboard' && this.shellRoute !== 'alerts')
    ) {
      return;
    }
    const now = Date.now();
    if (
      this.lastAlarmHistoryLoadMs > 0 &&
      now - this.lastAlarmHistoryLoadMs < 90_000
    ) {
      return;
    }
    void this.loadAlarmHistory();
  }

  async loadAlarmHistory(): Promise<void> {
    if (!this.deviceStore.isCloudSyncActive()) {
      this.alarmHistoryItems = [];
      this.alarmHistoryError = '';
      return;
    }
    if (this.alarmHistoryLoading) return;
    this.alarmHistoryLoading = true;
    this.alarmHistoryError = '';
    const { rows, error } = await this.deviceStore.fetchAlarmHistory();
    this.alarmHistoryLoading = false;
    this.lastAlarmHistoryLoadMs = Date.now();
    if (error) {
      this.alarmHistoryError = error;
      this.alarmHistoryItems = [];
      return;
    }
    this.alarmHistoryItems = rows;
  }

  deviceNameForAlarm(deviceId: string): string {
    return this.devices.find((d) => d.id === deviceId)?.name ?? deviceId;
  }

  async deleteAlarmHistoryRow(ev: DeviceAlarmEvent): Promise<void> {
    if (
      !window.confirm(
        '¿Eliminar este registro del historial? También se reinicia el aviso: la próxima notificación volverá a esperar el umbral y el retardo configurado.'
      )
    ) {
      return;
    }
    const { error } = await this.deviceStore.deleteAlarmEvent(ev);
    if (error) {
      alert(error);
      return;
    }
    this.alarmHistoryItems = this.alarmHistoryItems.filter((x) => x.id !== ev.id);
  }

  alarmKindLabel(kind: DeviceAlarmEvent['kind']): string {
    if (kind === 'offline') return 'Desconectado';
    if (kind === 'current_breach') return 'Corriente';
    return 'Umbral temperatura';
  }

  get hasDevices(): boolean {
    return this.devices.length > 0;
  }

  /** Última marca de tiempo entre todas las lecturas cargadas (referencia de frescura). */
  get lastDataRefreshLabel(): string {
    if (!this.readings.length) return '';
    let max = 0;
    for (const r of this.readings) {
      const t = new Date(r.at).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    if (!max) return '';
    return new Date(max).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  get filteredDevices(): DashboardDevice[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.devices;
    return this.devices.filter((d) => {
      const hay = [
        d.name,
        d.id,
        d.location,
        d.moduleId ?? '',
        d.espLocalIp ?? '',
        d.ownerUserId ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  /** Primeros caracteres del UUID de cuenta (vista admin). */
  formatOwnerUserIdShort(id: string | undefined): string {
    if (!id) return '';
    const t = id.replace(/-/g, '');
    return t.length > 10 ? `${t.slice(0, 10)}…` : t;
  }

  async loadAdminEmails(): Promise<void> {
    if (!this.isAdminView) return;
    this.adminListLoading = true;
    this.adminListFeedback = '';
    const { data, error } = await this.auth.client.from('admin_emails').select('email').order('email');
    this.adminListLoading = false;
    if (error) {
      this.adminListFeedback = error.message;
      this.adminListEmails = [];
      return;
    }
    this.adminListEmails = (data ?? []).map((r: { email: string }) => r.email);
  }

  async addAdminEmail(): Promise<void> {
    const raw = this.newAdminEmail.trim().toLowerCase();
    if (!raw || !raw.includes('@')) {
      this.adminListFeedback = 'Ingresá un email válido.';
      return;
    }
    this.adminListSaving = true;
    this.adminListFeedback = '';
    const { error } = await this.auth.client.from('admin_emails').insert({ email: raw });
    this.adminListSaving = false;
    if (error) {
      const msg = error.message ?? '';
      this.adminListFeedback =
        msg.includes('duplicate') || error.code === '23505' ? 'Ese email ya es administrador.' : msg;
      return;
    }
    this.newAdminEmail = '';
    await this.loadAdminEmails();
  }

  async removeAdminEmail(email: string): Promise<void> {
    if (!this.isAdminView) return;
    if (!window.confirm(`¿Quitar a ${email} como administrador?`)) return;
    this.adminListSaving = true;
    this.adminListFeedback = '';
    const { error } = await this.auth.client.from('admin_emails').delete().eq('email', email);
    this.adminListSaving = false;
    if (error) {
      this.adminListFeedback = error.message;
      return;
    }
    await this.loadAdminEmails();
  }

  get summaryTotal(): number {
    return this.devices.length;
  }

  get summaryNames(): number {
    return this.devices.filter((d) => d.name?.trim()).length;
  }

  /** Lecturas registradas en las últimas 24 h (aprox.) */
  get summaryNews(): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.readings.filter((r) => new Date(r.at).getTime() >= cutoff).length;
  }

  get activeAlerts(): DashboardAlert[] {
    const out: DashboardAlert[] = [];
    const nowMs = Date.now();
    const offlineAfterMs =
      typeof environment.deviceOfflineAfterMs === 'number' && environment.deviceOfflineAfterMs > 0
        ? environment.deviceOfflineAfterMs
        : 90000;
    const latestReadingByDevice = new Map<string, TemperatureReading>();
    for (const r of this.readings) {
      const t = new Date(r.at).getTime();
      if (!Number.isFinite(t)) continue;
      const prev = latestReadingByDevice.get(r.deviceId);
      if (!prev || t > new Date(prev.at).getTime()) {
        latestReadingByDevice.set(r.deviceId, r);
      }
    }

    for (const d of this.devices) {
      /** Solo si está explícitamente en false se silencian alarmas y notificaciones del navegador. */
      const alertsOn = d.alertsEnabled !== false;

      const latest = latestReadingByDevice.get(d.id);
      const latestAt = latest ? new Date(latest.at).getTime() : undefined;
      const disconnected = latestAt == null || nowMs - latestAt > offlineAfterMs;
      if (disconnected) {
        if (alertsOn) {
          const detail =
            latestAt != null
              ? `Última lectura: ${this.formatFullDateTime(latestAt)} · Ahora: ${this.formatFullDateTime(nowMs)}`
              : `Sin lecturas registradas · Ahora: ${this.formatFullDateTime(nowMs)}`;
          out.push({
            id: `${d.id}-offline`,
            deviceName: d.name,
            temperatureC: d.temperatureC ?? null,
            message: 'Dispositivo desconectado',
            detail,
            kind: 'offline',
            severity: 'critical',
          });
        }
        continue;
      }

      if (d.alertsEnabled === false) continue;

      const low = d.tempLowC ?? null;
      const high = d.tempHighC ?? null;
      const low2 = d.temp2LowC ?? null;
      const high2 = d.temp2HighC ?? null;
      const readingLabel =
        latestAt != null
          ? `Medición: ${this.formatFullDateTime(latestAt)}`
          : `Ahora: ${this.formatFullDateTime(nowMs)}`;
      const s1Name = d.sensor1Label?.trim() || 'Sensor 1';
      const s2Name = d.sensor2Label?.trim() || 'Sensor 2';

      const t1 = d.temperatureC;
      if (t1 != null) {
        if (high != null && t1 >= high) {
          out.push({
            id: `${d.id}-t1-high`,
            deviceName: d.name,
            temperatureC: t1,
            message: `${s1Name}: por encima del umbral`,
            detail: `${t1.toFixed(1)} °C (máx. ${high} °C) · ${readingLabel}`,
            kind: 'temp_high',
            severity: 'critical',
          });
        } else if (low != null && t1 <= low) {
          out.push({
            id: `${d.id}-t1-low`,
            deviceName: d.name,
            temperatureC: t1,
            message: `${s1Name}: por debajo del umbral`,
            detail: `${t1.toFixed(1)} °C (mín. ${low} °C) · ${readingLabel}`,
            kind: 'temp_low',
            severity: 'warning',
          });
        }
      }

      const t2 = d.temperature2C;
      if (t2 != null) {
        if (high2 != null && t2 >= high2) {
          out.push({
            id: `${d.id}-t2-high`,
            deviceName: d.name,
            temperatureC: t2,
            message: `${s2Name}: por encima del umbral`,
            detail: `${t2.toFixed(1)} °C (máx. ${high2} °C) · ${readingLabel}`,
            kind: 'temp_high',
            severity: 'critical',
          });
        } else if (low2 != null && t2 <= low2) {
          out.push({
            id: `${d.id}-t2-low`,
            deviceName: d.name,
            temperatureC: t2,
            message: `${s2Name}: por debajo del umbral`,
            detail: `${t2.toFixed(1)} °C (mín. ${low2} °C) · ${readingLabel}`,
            kind: 'temp_low',
            severity: 'warning',
          });
        }
      }

      const maxA = d.currentMaxA ?? null;
      const ia = latest ? effectiveCurrentAWithNominal(latest, d.nominalVoltageV) : null;
      if (
        ia != null &&
        Number.isFinite(ia) &&
        maxA != null &&
        Number.isFinite(maxA) &&
        ia > maxA
      ) {
        out.push({
          id: `${d.id}-current`,
          deviceName: d.name,
          temperatureC: null,
          currentA: ia,
          message: 'Corriente por encima del umbral',
          detail: `${ia.toFixed(2)} A (máx. ${maxA.toFixed(2)} A) · ${readingLabel}`,
          kind: 'current_high',
          severity: 'critical',
        });
      }
    }
    return out;
  }

  get summaryAlerts(): number {
    return this.activeAlerts.length;
  }

  get summaryAlarmEvents(): number {
    return this.alarmEventsCount;
  }

  get activities(): ActivityItem[] {
    const accents: ActivityItem['accent'][] = ['blue', 'teal', 'violet'];
    const latestByDevice = new Map<string, TemperatureReading>();
    for (const r of [...this.readings].reverse()) {
      if (!latestByDevice.has(r.deviceId)) latestByDevice.set(r.deviceId, r);
    }
    const items: ActivityItem[] = [];
    let i = 0;
    for (const [deviceId, r] of latestByDevice) {
      const d = this.devices.find((x) => x.id === deviceId);
      items.push({
        id: `${deviceId}-${r.at}`,
        deviceName: d?.name ?? deviceId,
        deviceId,
        online: d?.online ?? true,
        timeLabel: this.formatShortDate(r.at),
        accent: accents[i % accents.length],
      });
      i += 1;
      if (items.length >= 6) break;
    }
    if (items.length === 0) {
      return this.devices.slice(0, 6).map((d, j) => ({
        id: d.id,
        deviceName: d.name,
        deviceId: d.id,
        online: d.online,
        timeLabel: d.updatedAtLabel,
        accent: accents[j % accents.length],
      }));
    }
    return items;
  }

  get historyItems(): HistoryListItem[] {
    const source = this.selectedDeviceId
      ? this.readings.filter((r) => r.deviceId === this.selectedDeviceId)
      : this.readings;
    return [...source]
      .reverse()
      .slice(0, 18)
      .map((r) => {
        const d = this.devices.find((x) => x.id === r.deviceId);
        return {
          id: `${r.at}-${r.deviceId}`,
          deviceName: d?.name ?? r.deviceId,
          temperatureC: r.temperatureC,
          temp2C: r.temp2C ?? null,
          currentA: r.currentA ?? null,
          powerW: r.powerW ?? null,
          timeLabel: this.formatShortDate(r.at),
          sensor1Label: d?.sensor1Label,
          sensor2Label: d?.sensor2Label,
        };
      });
  }

  /** Etiquetas de tiempo para puntos del gráfico (lecturas reales) */
  get chartDayLabels(): string[] {
    return this.chartReadings().map((r) =>
      new Date(r.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    );
  }

  get avgDeltaLabel(): string {
    const series = this.chartReadings();
    const last = series.length ? series[series.length - 1].temperatureC : null;
    const prev = series.length > 1 ? series[series.length - 2].temperatureC : null;
    if (last == null || prev == null) return '—';
    const d = last - prev;
    const sign = d >= 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}°C`;
  }

  get chartCurrentLabel(): string {
    const series = this.chartReadings();
    const last = series.length ? series[series.length - 1].temperatureC : null;
    return last == null ? '—' : `${last.toFixed(1)}°C`;
  }

  get chartCurrentLabel2(): string {
    const series = this.chartReadings();
    const n = series.length;
    if (!n) return '—';
    const raw = series[n - 1].temp2C;
    if (raw != null && Number.isFinite(raw)) return `${raw.toFixed(1)}°C`;
    const carried = this.temp2SeriesForwardFilled(series)[n - 1];
    if (carried != null && Number.isFinite(carried)) return `${carried.toFixed(1)}°C`;
    return '—';
  }

  /** Resumen min/máx por canal en el rango del gráfico */
  get chartTempRangeLabel(): string {
    const series = this.chartReadings();
    if (!series.length) return '—';
    const t1 = series.map((r) => r.temperatureC);
    const n1 = this.selectedSensor1Name;
    let s = `${n1} min ${Math.min(...t1).toFixed(1)} · max ${Math.max(...t1).toFixed(1)}°C`;
    const t2vals = series
      .map((r) => r.temp2C)
      .filter((x): x is number => x != null && !Number.isNaN(x));
    if (t2vals.length) {
      const n2 = this.selectedSensor2Name;
      s += ` · ${n2} min ${Math.min(...t2vals).toFixed(1)} · max ${Math.max(...t2vals).toFixed(1)}°C`;
    }
    return s;
  }

  get chartTimelineItems(): { id: string; whenLabel: string; tempLabel: string }[] {
    const source = this.selectedDeviceId
      ? this.readings.filter((r) => r.deviceId === this.selectedDeviceId)
      : this.readings;
    const l1 = this.selectedSensor1Name;
    const l2 = this.selectedSensor2Name;
    return [...source]
      .reverse()
      .slice(0, 12)
      .map((r) => ({
        id: `${r.deviceId}-${r.at}`,
        whenLabel: this.formatChartDateTime(r.at),
        tempLabel: this.formatReadingTempsAndCurrentLine(r, l1, l2),
      }));
  }

  get selectedSensor1Name(): string {
    const d = this.selectedDevice;
    const s = d?.sensor1Label?.trim();
    return s || 'Sensor 1';
  }

  get selectedSensor2Name(): string {
    const d = this.selectedDevice;
    const s = d?.sensor2Label?.trim();
    return s || 'Sensor 2';
  }

  chartHasSecondSeries(): boolean {
    return this.chartReadings().some((r) => r.temp2C != null && Number.isFinite(r.temp2C));
  }

  chartHasCurrentSeries(): boolean {
    const v = this.selectedDevice?.nominalVoltageV;
    return this.chartReadings().some((r) => effectiveCurrentAWithNominal(r, v) != null);
  }

  get chartCurrentLatestLabel(): string {
    if (!this.chartHasCurrentSeries()) return '—';
    const series = this.chartReadings();
    const filled = this.currentSeriesForwardFilled(series);
    const n = filled.length;
    if (!n) return '—';
    const v = filled[n - 1];
    if (v == null || Number.isNaN(v)) return '—';
    return `${v.toFixed(2)} A`;
  }

  get chartCurrentRangeLabel(): string {
    const series = this.chartReadings();
    const filled = this.currentSeriesForwardFilled(series);
    const vals = filled.filter((x): x is number => x != null && Number.isFinite(x));
    if (!vals.length) return '—';
    return `I min ${Math.min(...vals).toFixed(2)} · max ${Math.max(...vals).toFixed(2)} A`;
  }

  currentChartPolylinePoints(): string {
    const series = this.chartReadings();
    const filled = this.currentSeriesForwardFilled(series);
    const w = 100;
    const n = series.length;
    if (n < 2) return '0,50 100,50';
    const sc = this.currentChartScale();
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = filled[i];
      if (p == null || Number.isNaN(p)) continue;
      const x = (i / (n - 1)) * w;
      pts.push(`${x},${sc.toSvgY(p)}`);
    }
    return pts.length >= 2 ? pts.join(' ') : '0,50 100,50';
  }

  get currentChartYMaxLabel(): string {
    const p = this.currentChartPaddedBounds();
    return p ? `${this.formatCurrentAxisTick(p.maxV, p.span)} A` : '—';
  }

  get currentChartYMidLabel(): string {
    const p = this.currentChartPaddedBounds();
    if (!p) return '—';
    return `${this.formatCurrentAxisTick((p.minV + p.maxV) / 2, p.span)} A`;
  }

  get currentChartYMinLabel(): string {
    const p = this.currentChartPaddedBounds();
    return p ? `${this.formatCurrentAxisTick(p.minV, p.span)} A` : '—';
  }

  get selectedDevice(): DashboardDevice | null {
    if (!this.selectedDeviceId) return null;
    return this.devices.find((d) => d.id === this.selectedDeviceId) ?? null;
  }

  get editingDevice(): DashboardDevice | null {
    if (!this.editingDeviceId) return null;
    return this.devices.find((d) => d.id === this.editingDeviceId) ?? null;
  }

  get selectedTelemetry(): TemperatureReading | null {
    if (!this.selectedDeviceId) return null;
    const source = this.readings
      .filter((r) => r.deviceId === this.selectedDeviceId)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return source[0] ?? null;
  }

  get selectedTelemetryCurrentA(): number | null {
    const t = this.selectedTelemetry;
    return t ? effectiveCurrentAWithNominal(t, this.selectedDevice?.nominalVoltageV) : null;
  }

  get hasHumidity(): boolean {
    return false;
  }

  /** Reservado cuando haya sensor de humedad real */
  readonly humidityLabel = '—';

  toggleChartExpanded(): void {
    this.chartExpanded = !this.chartExpanded;
  }

  /** Relleno bajo la curva (área / técnico). */
  chartShowsAreaFill(): boolean {
    return this.chartStylePreset === 'area' || this.chartStylePreset === 'technical';
  }

  readonly chartGridXStops = [20, 35, 50, 65, 80];

  loadChartStylePreset(): void {
    try {
      const v = localStorage.getItem(this.chartStyleStorageKey);
      if (v === 'area' || v === 'line' || v === 'minimal' || v === 'technical' || v === 'trend') {
        this.chartStylePreset = v;
        return;
      }
    } catch {
      /* */
    }
    this.chartStylePreset = 'area';
  }

  onChartStyleChange(): void {
    try {
      localStorage.setItem(this.chartStyleStorageKey, this.chartStylePreset);
    } catch {
      /* */
    }
  }

  async downloadTemperaturesPdf(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const deviceId = this.selectedDeviceId;
    if (!deviceId) {
      alert('Seleccioná un dispositivo para exportar lecturas.');
      return;
    }
    const fromMs = this.pdfDayStartMs(this.pdfExportFromDate);
    const toMs = this.pdfDayEndMs(this.pdfExportToDate);
    if (fromMs != null && toMs != null && fromMs > toMs) {
      alert('La fecha “Desde” no puede ser posterior a “Hasta”.');
      return;
    }
    const usePdfRange =
      this.pdfExportFromDate.trim() !== '' || this.pdfExportToDate.trim() !== '';
    const useRemotePdf =
      usePdfRange &&
      this.deviceStore.isCloudSyncActive() &&
      this.deviceStore.isCloudDeviceId(deviceId);

    this.pdfExporting = true;
    let rows: TemperatureReading[] = [];
    let pdfNoteLine = '';
    try {
      if (useRemotePdf) {
        const bounds = this.pdfExportRangeBounds();
        if (!bounds) {
          alert('Revisá las fechas del PDF.');
          return;
        }
        const fetched = await this.deviceStore.fetchRawReadingsForPdfExport(
          deviceId,
          bounds.from.toISOString(),
          bounds.to.toISOString()
        );
        if (fetched.error) {
          alert(fetched.error);
          return;
        }
        rows = [...fetched.rows].sort(
          (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
        );
        if (fetched.truncated) {
          pdfNoteLine =
            'En el rango hay más de 20.000 lecturas; el PDF incluye las primeras 20.000.';
        }
        const rawLen = rows.length;
        rows = this.evenSamplePdfRows(rows, this.pdfTableMaxRows);
        if (rawLen > this.pdfTableMaxRows) {
          pdfNoteLine =
            (pdfNoteLine ? pdfNoteLine + ' ' : '') +
            `Tabla: muestreo uniforme (${this.pdfTableMaxRows} de ${rawLen} lecturas en el período).`;
        }
      } else {
        rows = this.readingsForPdfExport();
      }

      if (!rows.length) {
        alert(
          'No hay lecturas en el rango elegido (o no hay datos en este equipo). Probá ampliar fechas o vaciar “Desde/Hasta” para usar las últimas 500.'
        );
        return;
      }
      const [jspdfMod, { autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const JsPDF = jspdfMod.default;

      const device = this.selectedDevice;
      const name = device?.name ?? 'dispositivo';
      const s1 = this.selectedSensor1Name;
      const s2 = this.selectedSensor2Name;
      const has2 = rows.some((r) => r.temp2C != null && Number.isFinite(r.temp2C));
      const nomV = device?.nominalVoltageV;
      const hasCurrent = rows.some((r) => effectiveCurrentAWithNominal(r, nomV) != null);

      const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      doc.setFontSize(14);
      doc.text(
        hasCurrent ? 'AR Monitoreo — temperaturas y corriente' : 'AR Monitoreo — temperaturas',
        14,
        16
      );
      doc.setFontSize(10);
      doc.text(`Dispositivo: ${name}`, 14, 23);
      doc.setFontSize(8);
      doc.setTextColor(80);
      const rangeLabel = this.pdfRangeLabelForHeader();
      let headerY = 28;
      doc.text(
        `Generado: ${new Date().toLocaleString('es-AR')} · ${rows.length} lecturas · ${rangeLabel}`,
        14,
        headerY
      );
      if (pdfNoteLine) {
        headerY += 5;
        doc.text(pdfNoteLine, 14, headerY);
        headerY += 2;
      }
      doc.setTextColor(0);

      const tableStartY = pdfNoteLine ? headerY + 2 : 32;

      const buildHead = (): string[][] => {
        const cols = ['Fecha y hora', `${s1} (°C)`];
        if (has2) cols.push(`${s2} (°C)`);
        if (hasCurrent) cols.push('Corriente (A)');
        return [cols];
      };
      const head = buildHead();
      const body: string[][] = rows.map((r) => {
        const t1 = r.temperatureC.toFixed(1);
        const row: string[] = [this.formatPdfDateTime(r.at), t1];
        if (has2) {
          row.push(
            r.temp2C != null && Number.isFinite(r.temp2C) ? r.temp2C.toFixed(1) : '—'
          );
        }
        if (hasCurrent) {
          const ia = effectiveCurrentAWithNominal(r, nomV);
          row.push(ia != null && Number.isFinite(ia) ? ia.toFixed(2) : '—');
        }
        return row;
      });

      autoTable(doc, {
        startY: tableStartY,
        head,
        body,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [30, 58, 138], textColor: 255 },
        alternateRowStyles: { fillColor: [245, 247, 250] },
        margin: { left: 14, right: 14 },
      });

      const safe = name.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]+/gi, '_').replace(/_+/g, '_').slice(0, 48);
      doc.save(`temperaturas_${safe}_${this.pdfDateStamp()}.pdf`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`No se pudo generar el PDF: ${msg}`);
    } finally {
      this.pdfExporting = false;
    }
  }

  private pdfDateStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  private formatPdfDateTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      return iso;
    }
  }

  /**
   * Lecturas del dispositivo en orden cronológico.
   * Si ambas fechas PDF están vacías: últimas 500.
   * Si hay “Desde” y/o “Hasta”: filtra por día local (inclusive); tope 3000 filas.
   */
  private readingsForPdfExport(): TemperatureReading[] {
    if (!this.selectedDeviceId) return [];
    let rows = [...this.readings.filter((r) => r.deviceId === this.selectedDeviceId)].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
    );

    const fromMs = this.pdfDayStartMs(this.pdfExportFromDate);
    const toMs = this.pdfDayEndMs(this.pdfExportToDate);
    const useRange = this.pdfExportFromDate.trim() !== '' || this.pdfExportToDate.trim() !== '';

    if (useRange) {
      if (fromMs != null) {
        rows = rows.filter((r) => new Date(r.at).getTime() >= fromMs);
      }
      if (toMs != null) {
        rows = rows.filter((r) => new Date(r.at).getTime() <= toMs);
      }
      if (rows.length > this.pdfTableMaxRows) {
        rows = this.evenSamplePdfRows(rows, this.pdfTableMaxRows);
      }
    } else {
      rows = rows.slice(-500);
    }
    return rows;
  }

  private pdfDayStartMs(yyyyMmDd: string): number | null {
    const t = yyyyMmDd?.trim();
    if (!t) return null;
    const d = new Date(`${t}T00:00:00`);
    const ms = d.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  private pdfDayEndMs(yyyyMmDd: string): number | null {
    const t = yyyyMmDd?.trim();
    if (!t) return null;
    const d = new Date(`${t}T23:59:59.999`);
    const ms = d.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  /**
   * Límites del rango PDF en hora local (misma idea que el filtro del análisis de gráfico).
   * Solo “hasta”: desde epoch; solo “desde”: hasta ahora.
   */
  private pdfExportRangeBounds(): { from: Date; to: Date } | null {
    const hasFrom = !!this.pdfExportFromDate?.trim();
    const hasTo = !!this.pdfExportToDate?.trim();
    if (!hasFrom && !hasTo) {
      return null;
    }

    let from: Date;
    let to: Date;

    if (hasFrom) {
      const parsed = this.parsePdfYmdLocal(this.pdfExportFromDate);
      if (!parsed || !Number.isFinite(parsed.getTime())) {
        return null;
      }
      from = parsed;
    } else {
      from = new Date(0);
    }

    if (hasTo) {
      const parsed = this.parsePdfYmdLocal(this.pdfExportToDate);
      if (!parsed || !Number.isFinite(parsed.getTime())) {
        return null;
      }
      to = new Date(parsed);
      to.setHours(23, 59, 59, 999);
    } else {
      // Misma lógica que día completo en “Hasta”: si falta, el tope es fin del día local (no solo “ahora”).
      const n = new Date();
      to = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59, 999);
    }

    if (from > to) {
      return null;
    }
    return { from, to };
  }

  /** Reparte filas en todo el intervalo temporal (evita quedarse solo con el final del rango). */
  private evenSamplePdfRows(sorted: TemperatureReading[], max: number): TemperatureReading[] {
    if (sorted.length <= max) {
      return sorted;
    }
    const out: TemperatureReading[] = [];
    const last = sorted.length - 1;
    for (let i = 0; i < max; i++) {
      const idx = Math.round((i * last) / (max - 1));
      out.push(sorted[idx]);
    }
    return out;
  }

  /** Lecturas de los últimos 7 días para el anexo del PDF de ficha (nube o memoria local). */
  private async readingsForEquipmentPdfAnnex(
    deviceId: string
  ): Promise<{ rows: TemperatureReading[]; note: string }> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    if (this.deviceStore.isCloudSyncActive() && this.deviceStore.isCloudDeviceId(deviceId)) {
      const fetched = await this.deviceStore.fetchRawReadingsForPdfExport(
        deviceId,
        fromIso,
        toIso,
        20000
      );
      if (fetched.error) {
        return { rows: [], note: `No se pudieron cargar lecturas: ${fetched.error}` };
      }
      let rows = [...fetched.rows].sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
      );
      let note = 'Origen: nube · últimos 7 días · valores con corrección aplicada.';
      if (fetched.truncated) {
        note += ' Se listan hasta 20.000 filas del período.';
      }
      const rawLen = rows.length;
      rows = this.evenSamplePdfRows(rows, this.pdfTableMaxRows);
      if (rawLen > this.pdfTableMaxRows) {
        note += ` Tabla: muestreo uniforme (${this.pdfTableMaxRows} de ${rawLen}).`;
      }
      return { rows, note };
    }

    let rows = this.readings
      .filter((r) => r.deviceId === deviceId)
      .filter((r) => {
        const t = new Date(r.at).getTime();
        return t >= from.getTime() && t <= to.getTime();
      });
    rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const rawLen = rows.length;
    if (rawLen === 0) {
      return {
        rows: [],
        note:
          'Origen: memoria local · sin lecturas en los últimos 7 días. Abrí el panel con el equipo en línea o usá nube.',
      };
    }
    const cap = Math.min(this.pdfTableMaxRows, 500);
    rows = this.evenSamplePdfRows(rows, Math.min(rawLen, cap));
    const note =
      rawLen > cap
        ? `Origen: memoria local · últimos 7 días · muestreo (${rows.length} de ${rawLen}). Sincronizá con la nube para el historial completo.`
        : `Origen: memoria local · últimos 7 días. Sincronizá con la nube para datos históricos completos.`;
    return { rows, note };
  }

  /** Rango del gráfico del PDF de ficha (vacío = últimos 7 días). */
  private equipmentChartRangeBounds(): { from: Date; to: Date } | null {
    const a = this.equipmentPdfChartFromDate?.trim() ?? '';
    const b = this.equipmentPdfChartToDate?.trim() ?? '';
    if (!a && !b) {
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86400000);
      return { from, to };
    }
    let from: Date;
    let to: Date;
    if (a) {
      const p = this.parsePdfYmdLocal(a);
      if (!p) return null;
      from = p;
    } else {
      from = new Date(0);
    }
    if (b) {
      const p = this.parsePdfYmdLocal(b);
      if (!p) return null;
      to = new Date(p);
      to.setHours(23, 59, 59, 999);
    } else {
      const n = new Date();
      to = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59, 999);
    }
    if (from > to) return null;
    return { from, to };
  }

  private async readingsForEquipmentChart(
    deviceId: string
  ): Promise<{ rows: TemperatureReading[]; rangeLabel: string; error?: string }> {
    const bounds = this.equipmentChartRangeBounds();
    if (!bounds) return { rows: [], rangeLabel: '', error: 'Rango inválido' };
    const rangeLabel = `${bounds.from.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })} → ${bounds.to.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    const fromIso = bounds.from.toISOString();
    const toIso = bounds.to.toISOString();

    if (this.deviceStore.isCloudSyncActive() && this.deviceStore.isCloudDeviceId(deviceId)) {
      const fetched = await this.deviceStore.fetchRawReadingsForPdfExport(
        deviceId,
        fromIso,
        toIso,
        15000
      );
      if (fetched.error) {
        return { rows: [], rangeLabel, error: fetched.error };
      }
      let rows = [...fetched.rows].sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
      );
      const rawLen = rows.length;
      const cap = Math.min(4000, Math.max(2, rawLen));
      rows = rawLen <= cap ? rows : this.evenSamplePdfRows(rows, cap);
      return { rows, rangeLabel };
    }

    let rows = this.readings
      .filter((r) => r.deviceId === deviceId)
      .filter((r) => {
        const t = new Date(r.at).getTime();
        return t >= bounds.from.getTime() && t <= bounds.to.getTime();
      });
    rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const rawLen = rows.length;
    const cap = Math.min(4000, Math.max(2, rawLen || 0));
    rows = rawLen <= cap || rawLen === 0 ? rows : this.evenSamplePdfRows(rows, cap);
    return { rows, rangeLabel };
  }

  /** Canvas PNG para incrustar en el PDF de ficha. */
  private renderEquipmentPdfChartDataUrl(
    rows: TemperatureReading[],
    dev: DashboardDevice,
    rangeLabel: string,
    s1: string,
    s2: string
  ): string | null {
    if (rows.length < 2) return null;
    const nomV = dev.nominalVoltageV;
    const times = rows.map((r) => new Date(r.at).getTime());
    const t0 = times[0]!;
    const tEnd = times[times.length - 1]!;
    const span = Math.max(1, tEnd - t0);

    const t1v = rows.map((r) => r.temperatureC);
    const t2v = rows.map((r) =>
      r.temp2C != null && Number.isFinite(r.temp2C) ? r.temp2C : null
    );
    const av = rows.map((r) => effectiveCurrentAWithNominal(r, nomV));
    const has2 = t2v.some((x) => x != null);
    let minTemp = Math.min(...t1v);
    let maxTemp = Math.max(...t1v);
    if (has2) {
      const t2nums = t2v.filter((x): x is number => x != null);
      if (t2nums.length) {
        minTemp = Math.min(minTemp, ...t2nums);
        maxTemp = Math.max(maxTemp, ...t2nums);
      }
    }
    let padT = Math.max(0.5, (maxTemp - minTemp) * 0.08);
    minTemp -= padT;
    maxTemp += padT;
    if (Math.abs(maxTemp - minTemp) < 0.01) {
      minTemp -= 0.5;
      maxTemp += 0.5;
    }

    const currNums = av.filter((x): x is number => x != null && Number.isFinite(x));
    const hasCurr = currNums.length > 0;
    let minA = hasCurr ? Math.min(...currNums) : 0;
    let maxA = hasCurr ? Math.max(...currNums) : 1;
    if (hasCurr) {
      const padA = Math.max(0.05, (maxA - minA) * 0.1);
      minA -= padA;
      maxA += padA;
      if (Math.abs(maxA - minA) < 1e-6) {
        minA -= 0.25;
        maxA += 0.25;
      }
    }

    const W = 900;
    const H = 420;
    const DPR = 2;
    const c = document.createElement('canvas');
    c.width = W * DPR;
    c.height = H * DPR;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.scale(DPR, DPR);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    const padL = 56;
    const padR = hasCurr ? 56 : 16;
    const padTop = 52;
    const padB = 44;
    const plotW = W - padL - padR;
    const plotH = H - padTop - padB;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    const xOf = (tm: number) => padL + ((tm - t0) / span) * plotW;
    const yTemp = (v: number) =>
      padTop + plotH - ((v - minTemp) / (maxTemp - minTemp)) * plotH;
    const yCurr = (v: number) =>
      padTop + plotH - ((v - minA) / (maxA - minA)) * plotH;

    const drawLine = (
      pts: { x: number; y: number }[],
      color: string,
      width: number
    ) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    };

    const pts1 = times.map((tm, i) => ({ x: xOf(tm), y: yTemp(t1v[i]!) }));
    drawLine(pts1, '#93c5fd', 2.2);
    if (has2) {
      const pts2: { x: number; y: number }[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (t2v[i] != null) pts2.push({ x: xOf(times[i]!), y: yTemp(t2v[i]!) });
      }
      drawLine(pts2, '#5eead4', 2);
    }
    if (hasCurr) {
      const ptsC: { x: number; y: number }[] = [];
      for (let i = 0; i < rows.length; i++) {
        const a = av[i];
        if (a != null && Number.isFinite(a)) ptsC.push({ x: xOf(times[i]!), y: yCurr(a) });
      }
      drawLine(ptsC, '#f59e0b', 2);
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText('Gráfico — ' + rangeLabel, 16, 22);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(dev.name ?? 'Equipo', 16, 40);

    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#93c5fd';
    ctx.fillText(`— ${s1}`, 16, H - 18);
    let lx = 16 + ctx.measureText(`— ${s1}`).width + 16;
    if (has2) {
      ctx.fillStyle = '#5eead4';
      ctx.fillText(`— ${s2}`, lx, H - 18);
      lx += ctx.measureText(`— ${s2}`).width + 16;
    }
    if (hasCurr) {
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('— Corriente (A)', lx, H - 18);
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = minTemp + ((4 - i) / 4) * (maxTemp - minTemp);
      ctx.fillText(`${v.toFixed(1)}°`, padL - 6, padTop + (plotH * i) / 4 + 4);
    }
    if (hasCurr) {
      ctx.textAlign = 'left';
      for (let i = 0; i <= 4; i++) {
        const v = minA + ((4 - i) / 4) * (maxA - minA);
        ctx.fillText(`${v.toFixed(2)} A`, padL + plotW + 6, padTop + (plotH * i) / 4 + 4);
      }
    }
    ctx.textAlign = 'left';

    return c.toDataURL('image/png');
  }

  private parsePdfYmdLocal(yyyyMmDd: string): Date | null {
    const v = (yyyyMmDd ?? '').trim();
    if (!v) return null;
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const d = new Date(year, month - 1, day, 0, 0, 0, 0);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  private pdfRangeLabelForHeader(): string {
    const a = this.pdfExportFromDate.trim();
    const b = this.pdfExportToDate.trim();
    if (!a && !b) return 'últimas 500 lecturas en memoria';
    if (a && b) return `desde ${a} hasta ${b}`;
    if (a) {
      const implicitTo = this.toDateInputString(new Date());
      return `desde ${a} hasta ${implicitTo}`;
    }
    return `hasta ${b}`;
  }

  /** Sugiere rango de 7 días según la última lectura en caché. */
  private syncPdfExportDateDefaults(): void {
    if (!this.selectedDeviceId) {
      this.pdfExportFromDate = '';
      this.pdfExportToDate = '';
      return;
    }
    const rows = [...this.readings.filter((r) => r.deviceId === this.selectedDeviceId)].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
    );
    if (rows.length) {
      const end = new Date(rows[rows.length - 1].at);
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      this.pdfExportFromDate = this.toDateInputString(start);
      this.pdfExportToDate = this.toDateInputString(end);
      return;
    }
    // Sin lecturas en caché (muy habitual en nube): igual rellenamos desde y hasta para que el PDF no quede solo “desde”.
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    this.pdfExportFromDate = this.toDateInputString(start);
    this.pdfExportToDate = this.toDateInputString(today);
  }

  private toDateInputString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** Navegación lateral / móvil: cada ítem va a su ruta dedicada. */
  scrollToSection(section: 'dashboard' | 'devices' | 'equipment' | 'alerts' | 'settings'): void {
    const paths: Record<typeof section, string> = {
      dashboard: '/dashboard',
      devices: '/dispositivos',
      equipment: '/ficha-equipo',
      alerts: '/alertas',
      settings: '/configuracion',
    };
    const path = paths[section];
    void this.router.navigate([path], {
      queryParams: this.selectedDeviceId ? { deviceId: this.selectedDeviceId } : { deviceId: null },
      replaceUrl: true,
    });
    if (section === 'settings' && this.isAdminView) void this.loadAdminEmails();
  }

  openChartInNewTab(e?: Event): void {
    e?.stopPropagation();
    const deviceId = this.selectedDeviceId ?? this.devices[0]?.id ?? null;
    if (!deviceId) return;
    const appPath = this.router.serializeUrl(
      this.router.createUrlTree(['/chart'], { queryParams: { deviceId } })
    );
    const normalizedPath = appPath.startsWith('/') ? appPath : `/${appPath}`;
    const absoluteUrl = `${window.location.origin}${normalizedPath}`;
    window.open(absoluteUrl, '_blank', 'noopener,noreferrer');
  }

  selectDevice(deviceId: string | null, syncQueryToUrl = true): void {
    const prevId = this.selectedDeviceId;
    this.selectedDeviceId = deviceId;
    if (prevId !== deviceId) {
      this.lastEquipmentLogFichaId = null;
    }
    this.sensorLabelsDirty = false;
    this.notificationSettingsDirty = false;
    this.dailyEnergyKwh = null;
    this.dailyEnergyError = '';
    this.syncNotificationFormWithSelected();
    this.syncPdfExportDateDefaults();
    const path = this.router.url.split('?')[0];
    if (path === '/ficha-equipo' && this.equipmentSheetAvailable() && deviceId && deviceId !== prevId) {
      void this.loadEquipmentPage();
    }
    if (syncQueryToUrl) {
      const shellPaths = ['/dashboard', '/dispositivos', '/ficha-equipo', '/alertas', '/configuracion'];
      if (shellPaths.includes(path)) {
        this.skipQueryParamDeviceSync = true;
        void this.router
          .navigate([path], {
            queryParams: deviceId ? { deviceId } : { deviceId: null },
            replaceUrl: true,
          })
          .finally(() => {
            this.skipQueryParamDeviceSync = false;
          });
      }
    }
  }

  onSensorLabelsInput(): void {
    this.sensorLabelsDirty = true;
  }

  async saveSensorLabels(): Promise<void> {
    const d = this.selectedDevice;
    if (!d) return;
    this.sensorLabelsSaving = true;
    this.sensorLabelsFeedback = '';
    try {
      const { cloudError } = await this.deviceStore.updateDeviceSensorLabels(
        d.id,
        this.sensor1LabelForm,
        this.sensor2LabelForm
      );
      this.sensorLabelsDirty = false;
      if (cloudError) {
        const needsSchema =
          cloudError.includes('sensor_1_label') ||
          cloudError.includes('sensor_2_label') ||
          cloudError.includes('Could not find the');
        this.sensorLabelsFeedback = needsSchema
          ? 'Guardado en este equipo. Para guardar en la nube, ejecutá el SQL: FRONTEND/supabase/sql/002_device_sensor_labels.sql'
          : `Guardado en este equipo. No se pudo subir a la nube: ${cloudError}`;
      } else {
        this.sensorLabelsFeedback = 'Nombres guardados correctamente.';
      }
      window.setTimeout(() => {
        this.sensorLabelsFeedback = '';
      }, 5000);
    } finally {
      this.sensorLabelsSaving = false;
    }
  }

  onNotificationFormChange(): void {
    if (this.syncingNotificationFormFromDevice) {
      return;
    }
    this.notificationSettingsDirty = true;
  }

  onCalibrationFormChange(): void {
    if (this.syncingCalibrationFromDevice) {
      return;
    }
    this.calibrationDirty = true;
  }

  async saveTempCalibration(): Promise<void> {
    const device = this.selectedDevice;
    if (!device) return;
    this.calibrationSaving = true;
    this.calibrationFeedback = '';
    let cloudError: string | undefined;
    try {
      const input: DeviceTempCalibrationInput = {
        temp1OffsetC: this.parseOffsetValue(this.temp1OffsetForm),
        temp2OffsetC: this.parseOffsetValue(this.temp2OffsetForm),
        temp3OffsetC: this.parseOffsetValue(this.temp3OffsetForm),
        currentOffsetA: this.parseOffsetValue(this.currentOffsetForm),
        powerOffsetW: this.parseOffsetValue(this.powerOffsetForm),
      };
      const result = await this.deviceStore.updateDeviceTempCalibration(device.id, input);
      cloudError = result.cloudError;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.calibrationFeedback = `No se pudo guardar: ${msg}`;
      return;
    } finally {
      this.calibrationSaving = false;
    }
    this.calibrationDirty = false;
    if (cloudError) {
      const needsCol =
        cloudError.includes('temp1_offset') ||
        cloudError.includes('current_offset') ||
        cloudError.includes('power_offset') ||
        cloudError.includes('column');
      this.calibrationFeedback = needsCol
        ? 'Ejecutá en Supabase los SQL: 007_temp_calibration_offsets.sql y 020_current_power_calibration.sql (si faltan columnas).'
        : `No se pudo guardar en la nube: ${cloudError}`;
    } else {
      this.calibrationFeedback =
        'Corrección guardada. Se actualizó la vista con la nube: corriente/potencia usan valor en crudo + offset cuando existe; si no hay columnas crudas en lecturas viejas, se aplica el offset sobre el valor guardado.';
      await this.deviceStore.refreshCloudReadingsNow();
    }
    window.setTimeout(() => {
      this.calibrationFeedback = '';
    }, 6000);
  }

  async saveNotificationSettings(): Promise<void> {
    const device = this.selectedDevice;
    if (!device) return;
    this.notificationSettingsFeedback = '';
    this.notificationSettingsFeedbackIsError = false;

    if (this.alertsEnabledForm && typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        void Notification.requestPermission();
      }
    }
    if (!this.alertsEnabledForm) {
      let currentMaxA: number | null;
      let nominalVoltageV: number;
      try {
        currentMaxA = this.parseCurrentMaxA(this.currentMaxForm);
        nominalVoltageV = this.parseNominalVoltageV(this.nominalVoltageForm);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.notificationSettingsFeedbackIsError = true;
        this.notificationSettingsFeedback = `Revisá corriente máx. (A) o tensión (V): ${msg}`;
        this.scheduleNotificationFeedbackClear();
        return;
      }
      this.notificationSettingsSaving = true;
      try {
        const result = await this.deviceStore.updateDeviceNotificationConfig(device.id, {
          alertsEnabled: false,
          tempLowC: null,
          tempHighC: null,
          temp2LowC: null,
          temp2HighC: null,
          currentMaxA,
          nominalVoltageV,
          tempPushCooldownMs: this.parseDelayMinutesToMs(this.tempPushDelayMinForm),
          offlinePushCooldownMs: this.parseDelayMinutesToMs(this.offlinePushDelayMinForm),
        });
        if (result.cloudError) {
          this.notificationSettingsFeedbackIsError = true;
          this.notificationSettingsFeedback = `Guardado en este equipo. No se pudo en la nube: ${result.cloudError}`;
        } else {
          this.notificationSettingsFeedback =
            'Umbrales guardados: notificaciones desactivadas para este dispositivo.';
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.notificationSettingsFeedbackIsError = true;
        this.notificationSettingsFeedback = `No se pudo guardar: ${msg}`;
      } finally {
        this.notificationSettingsSaving = false;
      }
      this.notificationSettingsDirty = false;
      this.scheduleNotificationFeedbackClear();
      return;
    }

    let low: number | null;
    let high: number | null;
    let low2: number | null;
    let high2: number | null;
    let currentMaxA: number | null;
    let nominalVoltageV: number;
    let delayMs: number;
    let offlineDelayMs: number;
    try {
      low = this.parseTempValue(this.tempLowForm);
      high = this.parseTempValue(this.tempHighForm);
      low2 = this.parseTempValue(this.temp2LowForm);
      high2 = this.parseTempValue(this.temp2HighForm);
      currentMaxA = this.parseCurrentMaxA(this.currentMaxForm);
      nominalVoltageV = this.parseNominalVoltageV(this.nominalVoltageForm);
      delayMs = this.parseDelayMinutesToMs(this.tempPushDelayMinForm);
      offlineDelayMs = this.parseDelayMinutesToMs(this.offlinePushDelayMinForm);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.notificationSettingsFeedbackIsError = true;
      this.notificationSettingsFeedback = `Revisá los valores (min/máx/retardo/corriente/tensión): ${msg}`;
      this.scheduleNotificationFeedbackClear();
      return;
    }
    if (low != null && high != null && low > high) {
      this.notificationSettingsFeedbackIsError = true;
      this.notificationSettingsFeedback =
        'Sensor 1: el mínimo no puede ser mayor al máximo.';
      this.scheduleNotificationFeedbackClear();
      return;
    }
    if (low2 != null && high2 != null && low2 > high2) {
      this.notificationSettingsFeedbackIsError = true;
      this.notificationSettingsFeedback =
        'Sensor 2: el mínimo no puede ser mayor al máximo.';
      this.scheduleNotificationFeedbackClear();
      return;
    }

    this.notificationSettingsSaving = true;
    try {
      const result = await this.deviceStore.updateDeviceNotificationConfig(device.id, {
        alertsEnabled: true,
        tempLowC: low,
        tempHighC: high,
        temp2LowC: low2,
        temp2HighC: high2,
        currentMaxA,
        nominalVoltageV,
        tempPushCooldownMs: delayMs,
        offlinePushCooldownMs: offlineDelayMs,
      });
      if (result.cloudError) {
        this.notificationSettingsFeedbackIsError = true;
        this.notificationSettingsFeedback = `Guardado en este equipo. No se pudo en la nube: ${result.cloudError}`;
      } else {
        this.notificationSettingsFeedback =
          'Umbrales guardados correctamente (mín., máx., retardo y avisos).';
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.notificationSettingsFeedbackIsError = true;
      this.notificationSettingsFeedback = `No se pudo guardar: ${msg}`;
    } finally {
      this.notificationSettingsSaving = false;
    }
    this.notificationSettingsDirty = false;
    this.scheduleNotificationFeedbackClear();
  }

  private scheduleNotificationFeedbackClear(): void {
    window.setTimeout(() => {
      this.notificationSettingsFeedback = '';
    }, 6000);
  }

  async refreshWebPushUi(): Promise<void> {
    if (!environment.deviceCloudSync) {
      this.webPushUiState = 'unsupported';
      return;
    }
    this.webPushUiState = 'loading';
    this.webPushUiState = await this.webPush.getUiState();
  }

  async enableWebPush(): Promise<void> {
    this.webPushBusy = true;
    this.webPushFeedback = '';
    const r = await this.webPush.subscribeBackgroundAlerts();
    this.webPushBusy = false;
    this.webPushFeedback = r.message;
    this.webPushFeedbackIsError = !r.ok;
    await this.refreshWebPushUi();
  }

  async disableWebPush(): Promise<void> {
    this.webPushBusy = true;
    this.webPushFeedback = '';
    const r = await this.webPush.unsubscribeBackground();
    this.webPushBusy = false;
    this.webPushFeedback = r.message;
    this.webPushFeedbackIsError = !r.ok;
    await this.refreshWebPushUi();
  }

  logout(): void {
    void this.auth.signOut().then(() => {
      void this.router.navigate(['/login']);
    });
  }

  resetAlarmEvents(): void {
    this.alarmEventsCount = 0;
    this.persistAlarmEventsCount();
  }

  openAddDeviceModal(): void {
    this.provisioningOpen = false;
    this.provisioningCredentials = null;
    this.deviceModalMode = 'add';
    this.editingDeviceId = null;
    this.deviceForm.reset({
      name: '',
      location: '',
      moduleId: '',
      espLocalIp: '',
      manualTemp: '',
    });
  }

  openEditDeviceModal(d: DashboardDevice): void {
    this.deviceModalMode = 'edit';
    this.editingDeviceId = d.id;
    this.deviceForm.patchValue({
      name: d.name,
      location: d.location === 'Sin ubicación' ? '' : d.location,
      moduleId: d.moduleId ?? '',
      espLocalIp: d.espLocalIp ?? '',
      manualTemp: '',
    });
  }

  closeDeviceModal(): void {
    this.deviceModalMode = null;
    this.editingDeviceId = null;
    this.addDeviceSubmitting = false;
  }

  async submitDeviceForm(): Promise<void> {
    if (this.deviceForm.invalid) {
      this.deviceForm.markAllAsTouched();
      return;
    }
    const v = this.deviceForm.getRawValue();
    const tempStr = (v.manualTemp ?? '').trim().replace(',', '.');
    const manualTemp =
      tempStr === '' ? null : Number.parseFloat(tempStr);

    if (this.deviceModalMode === 'add') {
      this.addDeviceSubmitting = true;
      try {
        const result = await this.deviceStore.addDeviceFromFormAsync({
          name: v.name ?? '',
          location: v.location ?? '',
          moduleId: v.moduleId ?? '',
          espLocalIp: v.espLocalIp ?? '',
        });
        if (!result.ok) {
          alert(result.error);
          return;
        }
        if (manualTemp != null && !Number.isNaN(manualTemp)) {
          this.deviceStore.recordTemperatureReading(result.id, manualTemp);
        }
        this.closeDeviceModal();
        if (result.credentials) {
          this.provisioningCredentials = result.credentials;
          this.provisioningOpen = true;
        }
      } finally {
        this.addDeviceSubmitting = false;
      }
      return;
    }

    if (this.deviceModalMode === 'edit' && this.editingDeviceId) {
      const result = await this.deviceStore.updateDeviceMeta(this.editingDeviceId, {
        name: v.name ?? '',
        location: v.location ?? '',
        moduleId: v.moduleId ?? '',
        espLocalIp: v.espLocalIp ?? '',
      });
      if (!result.ok) {
        alert(
          result.error
            ? `No se pudo guardar el nombre en la nube: ${result.error}`
            : 'No se pudo guardar el dispositivo.'
        );
        return;
      }
      if (manualTemp != null && !Number.isNaN(manualTemp)) {
        this.deviceStore.recordTemperatureReading(this.editingDeviceId, manualTemp);
      }
    }
    this.closeDeviceModal();
  }

  async confirmDeleteDevice(d: DashboardDevice): Promise<void> {
    if (!confirm('¿Eliminar dispositivo?')) return;
    const r = await this.deviceStore.removeDeviceAsync(d.id);
    if (!r.ok) {
      alert(
        r.error
          ? `No se pudo borrar en la nube: ${r.error}`
          : 'No se pudo eliminar el dispositivo.'
      );
    }
  }

  loadDemoDevices(): void {
    if (this.deviceStore.isUsingCloudSync()) {
      alert('Con sesión en la nube no se usa Demo. Creá un dispositivo desde + Dispositivo.');
      return;
    }
    this.deviceStore.loadSampleDevices();
  }

  closeProvisioningModal(): void {
    this.provisioningOpen = false;
    this.provisioningCredentials = null;
  }

  copyProvisioning(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  formatTemp(c: number | null): string {
    if (c == null || Number.isNaN(c)) return '—';
    const sign = c < 0 ? '-' : '';
    return `${sign}${Math.abs(c).toFixed(1)}°C`;
  }

  /** Tarjetas / widgets grandes: dos decimales (mejor lectura en pantalla). */
  formatTempCard(c: number | null): string {
    if (c == null || Number.isNaN(c)) return '—';
    const sign = c < 0 ? '-' : '';
    return `${sign}${Math.abs(c).toFixed(2)}°C`;
  }

  /** Solo el número; signo solo si es negativo; la unidad va en un <span> aparte. */
  formatTempCardValueOnly(c: number | null): string {
    if (c == null || Number.isNaN(c)) return '—';
    const sign = c < 0 ? '-' : '';
    return `${sign}${Math.abs(c).toFixed(2)}`;
  }

  formatDeviceClampAmpNum(d: DashboardDevice): string {
    const ia = effectiveCurrentAWithNominal(
      { currentA: d.currentA ?? null, powerW: d.powerW ?? null },
      d.nominalVoltageV
    );
    return ia != null && Number.isFinite(ia) ? ia.toFixed(2) : '—';
  }

  /** Lectura actual: layout dos columnas cuando hay ambos canales con valor. */
  hasDualTelemetry(t: TemperatureReading): boolean {
    return (
      t.temperatureC != null &&
      Number.isFinite(t.temperatureC) &&
      t.temp2C != null &&
      Number.isFinite(t.temp2C)
    );
  }

  /** Tarjeta dispositivo con un solo canal: etiqueta coherente con el valor mostrado. */
  deviceFirstSensorLabel(d: DashboardDevice): string {
    if (d.temperatureC != null) return d.sensor1Label?.trim() || 'Sensor 1';
    return d.sensor2Label?.trim() || 'Sensor 2';
  }

  deviceFirstTempC(d: DashboardDevice): number | null {
    if (d.temperatureC != null) return d.temperatureC;
    if (d.temperature2C != null) return d.temperature2C;
    return null;
  }

  /** Historial / línea de tiempo: nombres personalizados si existen */
  formatHistoryTemps(h: HistoryListItem): string {
    const n1 = h.sensor1Label?.trim() || 'Sensor 1';
    const n2 = h.sensor2Label?.trim() || 'Sensor 2';
    const t1 = this.formatTemp(h.temperatureC);
    let s =
      h.temp2C == null || Number.isNaN(h.temp2C)
        ? `${n1}: ${t1}`
        : `${n1}: ${t1} · ${n2}: ${this.formatTemp(h.temp2C)}`;
    const ia = effectiveCurrentAWithNominal(
      { currentA: h.currentA ?? null, powerW: h.powerW ?? null },
      this.selectedDevice?.nominalVoltageV
    );
    if (ia != null && Number.isFinite(ia)) s += ` · ${ia.toFixed(2)} A`;
    return s;
  }

  private formatReadingTempsLine(
    r: TemperatureReading,
    name1 = 'Sensor 1',
    name2 = 'Sensor 2'
  ): string {
    const t1 = this.formatTemp(r.temperatureC);
    if (r.temp2C == null || Number.isNaN(r.temp2C)) return `${name1}: ${t1}`;
    return `${name1}: ${t1} · ${name2}: ${this.formatTemp(r.temp2C)}`;
  }

  private formatReadingTempsAndCurrentLine(
    r: TemperatureReading,
    name1 = 'Sensor 1',
    name2 = 'Sensor 2'
  ): string {
    let s = this.formatReadingTempsLine(r, name1, name2);
    const ia = effectiveCurrentAWithNominal(r, this.selectedDevice?.nominalVoltageV);
    if (ia != null && Number.isFinite(ia)) {
      s += ` · ${ia.toFixed(2)} A`;
    }
    return s;
  }

  formatCurrent(amps: number | null | undefined): string {
    if (amps == null || Number.isNaN(amps)) return '—';
    return `${amps.toFixed(2)} A`;
  }

  /** Tarjeta tipo sensor: hay pinza/potencia cuando llega corriente o potencia > 0. */
  deviceShowClampRow(d: DashboardDevice): boolean {
    return (
      (d.currentA != null && Number.isFinite(d.currentA)) ||
      (d.powerW != null && Number.isFinite(d.powerW) && d.powerW > 0)
    );
  }

  formatDeviceClampMain(d: DashboardDevice): string {
    const n = this.formatDeviceClampAmpNum(d);
    return n === '—' ? '—' : `${n} A`;
  }

  formatDeviceClampSub(d: DashboardDevice): string {
    const ia = effectiveCurrentAWithNominal(
      { currentA: d.currentA ?? null, powerW: d.powerW ?? null },
      d.nominalVoltageV
    );
    if (ia == null || !Number.isFinite(ia)) return '';
    const nv = d.nominalVoltageV != null && d.nominalVoltageV > 0 ? d.nominalVoltageV : 220;
    const kw = (ia * nv) / 1000;
    return `≈ ${kw.toFixed(2)} kW · ${nv} V`;
  }

  async loadDailyEnergyConsumption(): Promise<void> {
    const device = this.selectedDevice;
    this.dailyEnergyError = '';
    this.dailyEnergyKwh = null;
    if (!device || !this.environment.deviceCloudSync) {
      this.dailyEnergyError = 'Seleccioná un dispositivo sincronizado con la nube.';
      return;
    }
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    this.dailyEnergyLoading = true;
    try {
      const { kwh, error } = await this.deviceStore.fetchDeviceEnergyKwh(
        device.id,
        start.toISOString(),
        end.toISOString()
      );
      if (error) {
        this.dailyEnergyError =
          /function|schema|not find|does not exist/i.test(error)
            ? 'Ejecutá en Supabase: FRONTEND/supabase/sql/019_nominal_voltage_energy_kwh.sql'
            : error;
        return;
      }
      this.dailyEnergyKwh = kwh ?? 0;
    } finally {
      this.dailyEnergyLoading = false;
    }
  }

  formatPressure(bar: number | null | undefined): string {
    if (bar == null || Number.isNaN(bar)) return '—';
    return `${bar.toFixed(2)} bar`;
  }

  /** Líneas horizontales de rejilla en coordenadas del viewBox 0–100 */
  readonly chartGridYStops = [14, 34, 54, 74, 86];

  get chartYMaxLabel(): string {
    const r = this.chartPaddedBounds();
    return r ? this.formatChartAxisTick(r.maxV, r.span) : '—';
  }

  get chartYMidLabel(): string {
    const r = this.chartPaddedBounds();
    if (!r) return '—';
    return this.formatChartAxisTick((r.minV + r.maxV) / 2, r.span);
  }

  get chartYMinLabel(): string {
    const r = this.chartPaddedBounds();
    return r ? this.formatChartAxisTick(r.minV, r.span) : '—';
  }

  /** Min/máx reales de los datos (sin margen). */
  private chartValueRange(): { minV: number; maxV: number } | null {
    const series = this.chartReadings();
    const vals: number[] = [];
    for (const r of series) {
      vals.push(r.temperatureC);
      if (r.temp2C != null && !Number.isNaN(r.temp2C)) vals.push(r.temp2C);
    }
    if (!vals.length) return null;
    return { minV: Math.min(...vals), maxV: Math.max(...vals) };
  }

  /**
   * Escala del gráfico con margen para que el eje Y no quede “vacío” y las
   * etiquetas no se vean todas iguales al redondear.
   */
  private chartPaddedBounds(): { minV: number; maxV: number; span: number } | null {
    const raw = this.chartValueRange();
    if (!raw) return null;
    let span = raw.maxV - raw.minV;
    if (span < 1e-6) {
      span = 0.6;
      return {
        minV: raw.minV - span / 2,
        maxV: raw.maxV + span / 2,
        span,
      };
    }
    const pad = Math.max(0.25, span * 0.06, Math.abs(raw.maxV) * 0.01);
    return {
      minV: raw.minV - pad,
      maxV: raw.maxV + pad,
      span: span + 2 * pad,
    };
  }

  private formatChartAxisTick(value: number, span: number): string {
    const decimals = span < 0.35 ? 2 : span < 2.5 ? 1 : 0;
    return `${value.toFixed(decimals)}°C`;
  }

  chartPolylinePoints(): string {
    const series = this.chartPointsForDraw();
    const w = 100;
    const n = series.length;
    if (n < 2) return '0,50 100,50';
    const sc = this.chartScale();
    return series
      .map((r, i) => {
        const x = (i / (n - 1)) * w;
        const y = sc.toSvgY(r.temperatureC);
        return `${x},${y}`;
      })
      .join(' ');
  }

  /** Serie dibujada (en dashboard siempre la misma que chartReadings). */
  private chartPointsForDraw(): TemperatureReading[] {
    return this.chartReadings();
  }

  chartTrendSegments1(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> {
    if (this.chartStylePreset !== 'trend') return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const sc = this.chartScale();
    const eps = 1e-4;
    const out: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      trend: 'up' | 'down' | 'flat';
    }> = [];
    for (let i = 0; i < n - 1; i++) {
      const t0 = series[i].temperatureC;
      const t1 = series[i + 1].temperatureC;
      const d = t1 - t0;
      const trend = d > eps ? 'up' : d < -eps ? 'down' : 'flat';
      const x1 = (i / (n - 1)) * 100;
      const x2 = ((i + 1) / (n - 1)) * 100;
      out.push({ x1, y1: sc.toSvgY(t0), x2, y2: sc.toSvgY(t1), trend });
    }
    return out;
  }

  chartTrendMarkers1(): Array<{ cx: number; cy: number }> {
    if (this.chartStylePreset !== 'trend') return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const sc = this.chartScale();
    return series.map((r, i) => ({
      cx: (i / (n - 1)) * 100,
      cy: sc.toSvgY(r.temperatureC),
    }));
  }

  chartTrendSegments2(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> {
    if (this.chartStylePreset !== 'trend' || !this.chartHasSecondSeries()) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScale();
    const eps = 1e-4;
    const out: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      trend: 'up' | 'down' | 'flat';
    }> = [];
    for (let i = 0; i < n - 1; i++) {
      const t0 = filled[i];
      const t1 = filled[i + 1];
      if (t0 == null || t1 == null || Number.isNaN(t0) || Number.isNaN(t1)) continue;
      const d = t1 - t0;
      const trend = d > eps ? 'up' : d < -eps ? 'down' : 'flat';
      const x1 = (i / (n - 1)) * 100;
      const x2 = ((i + 1) / (n - 1)) * 100;
      out.push({ x1, y1: sc.toSvgY(t0), x2, y2: sc.toSvgY(t1), trend });
    }
    return out;
  }

  chartTrendMarkers2(): Array<{ cx: number; cy: number }> {
    if (this.chartStylePreset !== 'trend' || !this.chartHasSecondSeries()) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScale();
    const pts: Array<{ cx: number; cy: number }> = [];
    for (let i = 0; i < n; i++) {
      const t = filled[i];
      if (t == null || Number.isNaN(t)) continue;
      pts.push({ cx: (i / (n - 1)) * 100, cy: sc.toSvgY(t) });
    }
    return pts;
  }

  /**
   * Segunda serie (temp2), mismo eje Y. Rellena huecos con el último valor
   * conocido para que la línea no “escalone” cuando el backend no manda temp2 en cada fila.
   */
  chartPolylinePoints2(): string {
    const series = this.chartPointsForDraw();
    const w = 100;
    const n = series.length;
    if (n < 2) return '';
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScale();
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const t2 = filled[i];
      if (t2 == null || Number.isNaN(t2)) continue;
      const x = (i / (n - 1)) * w;
      pts.push(`${x},${sc.toSvgY(t2)}`);
    }
    return pts.length >= 2 ? pts.join(' ') : '';
  }

  /** Solo para dibujo: arrastra temp2 hacia adelante y rellena el inicio hacia atrás. */
  private temp2SeriesForwardFilled(series: TemperatureReading[]): (number | null)[] {
    const n = series.length;
    const out: (number | null)[] = new Array(n).fill(null);
    let last: number | null = null;
    for (let i = 0; i < n; i++) {
      const t = series[i].temp2C;
      if (t != null && Number.isFinite(t)) last = t;
      out[i] = last;
    }
    let next: number | null = null;
    for (let i = n - 1; i >= 0; i--) {
      if (out[i] == null && next != null) out[i] = next;
      if (out[i] != null) next = out[i];
    }
    return out;
  }

  private chartScale(): {
    minV: number;
    maxV: number;
    toSvgY: (v: number) => number;
  } {
    const padded = this.chartPaddedBounds();
    if (!padded) {
      return {
        minV: 0,
        maxV: 1,
        toSvgY: () => 50,
      };
    }
    const { minV, maxV } = padded;
    const span = maxV - minV || 1;
    return {
      minV,
      maxV,
      toSvgY: (v: number) => {
        const ratio = (v - minV) / span;
        const fromBottom = 8 + ratio * 84;
        return 100 - fromBottom;
      },
    };
  }

  private chartReadings(): TemperatureReading[] {
    const source = this.selectedDeviceId
      ? this.readings.filter((r) => r.deviceId === this.selectedDeviceId)
      : this.readings;
    return [...source]
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      .slice(-48);
  }

  private currentSeriesForwardFilled(series: TemperatureReading[]): (number | null)[] {
    const nomV = this.selectedDevice?.nominalVoltageV;
    const n = series.length;
    const out: (number | null)[] = new Array(n).fill(null);
    let last: number | null = null;
    for (let i = 0; i < n; i++) {
      const t = effectiveCurrentAWithNominal(series[i], nomV);
      if (t != null && Number.isFinite(t)) last = t;
      out[i] = last;
    }
    let next: number | null = null;
    for (let i = n - 1; i >= 0; i--) {
      if (out[i] == null && next != null) out[i] = next;
      if (out[i] != null) next = out[i];
    }
    return out;
  }

  private currentChartValueRange(): { minV: number; maxV: number } | null {
    const series = this.chartReadings();
    const filled = this.currentSeriesForwardFilled(series);
    const vals = filled.filter((x): x is number => x != null && Number.isFinite(x));
    if (!vals.length) return null;
    return { minV: Math.min(...vals), maxV: Math.max(...vals) };
  }

  private currentChartPaddedBounds(): { minV: number; maxV: number; span: number } | null {
    const raw = this.currentChartValueRange();
    if (!raw) return null;
    let span = raw.maxV - raw.minV;
    if (span < 1e-6) {
      span = Math.max(0.5, Math.abs(raw.maxV) * 0.25, 0.15);
      return {
        minV: raw.minV - span / 2,
        maxV: raw.maxV + span / 2,
        span,
      };
    }
    const pad = Math.max(0.05, span * 0.08);
    return {
      minV: raw.minV - pad,
      maxV: raw.maxV + pad,
      span: span + 2 * pad,
    };
  }

  private currentChartScale(): { toSvgY: (v: number) => number } {
    const padded = this.currentChartPaddedBounds();
    if (!padded) {
      return { toSvgY: () => 50 };
    }
    const { minV, maxV } = padded;
    const span = maxV - minV || 1;
    return {
      toSvgY: (v: number) => {
        const ratio = (v - minV) / span;
        const fromBottom = 8 + ratio * 84;
        return 100 - fromBottom;
      },
    };
  }

  private formatCurrentAxisTick(value: number, span: number): string {
    if (span >= 40) return value.toFixed(1);
    if (span >= 8) return value.toFixed(2);
    return value.toFixed(3);
  }

  private formatShortDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  private formatChartDateTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  private syncNotificationFormWithSelected(): void {
    const device = this.selectedDevice;
    if (!device) {
      this.alertsEnabledForm = false;
      this.tempLowForm = '';
      this.tempHighForm = '';
      this.temp2LowForm = '';
      this.temp2HighForm = '';
      this.currentMaxForm = '';
      this.nominalVoltageForm = '220';
      this.tempPushDelayMinForm = '15';
      this.offlinePushDelayMinForm = '15';
      this.temp1OffsetForm = '0';
      this.temp2OffsetForm = '0';
      this.temp3OffsetForm = '0';
      this.currentOffsetForm = '0';
      this.powerOffsetForm = '0';
      this.calibrationDirty = false;
      this.sensor1LabelForm = '';
      this.sensor2LabelForm = '';
      this.sensorLabelsDirty = false;
      return;
    }
    // Umbrales/notificaciones: solo si el usuario no está editando ese bloque (no return global:
    // si no, nunca se sincronizan nombres ni corrección de sensores).
    if (!this.notificationSettingsDirty) {
      this.syncingNotificationFormFromDevice = true;
      try {
        this.alertsEnabledForm = device.alertsEnabled !== false;
        this.tempLowForm =
          device.tempLowC == null || Number.isNaN(device.tempLowC) ? '' : String(device.tempLowC);
        this.tempHighForm =
          device.tempHighC == null || Number.isNaN(device.tempHighC) ? '' : String(device.tempHighC);
        this.temp2LowForm =
          device.temp2LowC == null || Number.isNaN(device.temp2LowC as number)
            ? ''
            : String(device.temp2LowC);
        this.temp2HighForm =
          device.temp2HighC == null || Number.isNaN(device.temp2HighC as number)
            ? ''
            : String(device.temp2HighC);
        this.currentMaxForm =
          device.currentMaxA == null || Number.isNaN(device.currentMaxA as number)
            ? ''
            : String(device.currentMaxA);
        this.nominalVoltageForm =
          device.nominalVoltageV == null || Number.isNaN(device.nominalVoltageV)
            ? '220'
            : String(device.nominalVoltageV);
        this.tempPushDelayMinForm = String(
          this.cooldownMsToMinutes(device.tempPushCooldownMs ?? 15 * 60 * 1000)
        );
        const offlineMs =
          device.offlinePushCooldownMs ??
          device.tempPushCooldownMs ??
          15 * 60 * 1000;
        this.offlinePushDelayMinForm = String(this.cooldownMsToMinutes(offlineMs));
      } finally {
        this.syncingNotificationFormFromDevice = false;
      }
    }
    // Mientras el usuario escribe, no pisar el input con refrescos de polling.
    if (!this.sensorLabelsDirty) {
      this.sensor1LabelForm = device.sensor1Label?.trim() || 'Sensor 1';
      this.sensor2LabelForm = device.sensor2Label?.trim() || 'Sensor 2';
    }
    if (!this.calibrationDirty) {
      this.syncingCalibrationFromDevice = true;
      try {
        this.temp1OffsetForm =
          device.temp1OffsetC == null || Number.isNaN(device.temp1OffsetC)
            ? '0'
            : String(device.temp1OffsetC);
        this.temp2OffsetForm =
          device.temp2OffsetC == null || Number.isNaN(device.temp2OffsetC)
            ? '0'
            : String(device.temp2OffsetC);
        this.temp3OffsetForm =
          device.temp3OffsetC == null || Number.isNaN(device.temp3OffsetC)
            ? '0'
            : String(device.temp3OffsetC);
        this.currentOffsetForm =
          device.currentOffsetA == null || Number.isNaN(device.currentOffsetA)
            ? '0'
            : String(device.currentOffsetA);
        this.powerOffsetForm =
          device.powerOffsetW == null || Number.isNaN(device.powerOffsetW)
            ? '0'
            : String(device.powerOffsetW);
      } finally {
        this.syncingCalibrationFromDevice = false;
      }
    }
  }

  private parseTempValue(value: string | number | null | undefined): number | null {
    const s = value == null ? '' : String(value).trim().replace(',', '.');
    if (!s) return null;
    const n = Number.parseFloat(s);
    return Number.isNaN(n) ? null : n;
  }

  /** Vacío = sin límite; valor en A debe ser ≥ 0. */
  private parseCurrentMaxA(value: string | number | null | undefined): number | null {
    const s = value == null ? '' : String(value).trim().replace(',', '.');
    if (!s) return null;
    const n = Number.parseFloat(s);
    if (Number.isNaN(n)) throw new Error('Corriente máx. inválida');
    if (n < 0) throw new Error('La corriente máx. no puede ser negativa');
    return n;
  }

  /** Tensión nominal (V), p. ej. 220 o 380; vacío = 220. */
  private parseNominalVoltageV(value: string | number | null | undefined): number {
    const s = value == null ? '' : String(value).trim().replace(',', '.');
    if (!s) return 220;
    const n = Number.parseFloat(s);
    if (Number.isNaN(n)) throw new Error('Tensión nominal inválida');
    if (n < 50 || n > 600) throw new Error('Tensión nominal: entre 50 y 600 V (ej. 220, 380)');
    return n;
  }

  /** Texto principal en la lista de alertas (°C o A). */
  formatAlertPrimary(al: DashboardAlert): string {
    if (al.kind === 'current_high') {
      return al.currentA != null && Number.isFinite(al.currentA)
        ? `${al.currentA.toFixed(2)} A`
        : '—';
    }
    return this.formatTemp(al.temperatureC);
  }

  /** Offset en °C (puede ser negativo). Vacío = 0. */
  private parseOffsetValue(value: string | number | null | undefined): number {
    const s = value == null ? '' : String(value).trim().replace(',', '.');
    if (!s) return 0;
    const n = Number.parseFloat(s);
    return Number.isNaN(n) ? 0 : n;
  }

  private parseDelayMinutesToMs(value: string | number | null | undefined): number {
    const s = value == null ? '' : String(value).trim().replace(',', '.');
    const n = Number.parseFloat(s);
    const safeMinutes = Number.isNaN(n) ? 15 : Math.min(240, Math.max(1, n));
    return Math.round(safeMinutes * 60 * 1000);
  }

  private cooldownMsToMinutes(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 15;
    return Math.max(1, Math.round(value / 60000));
  }

  private shouldPlayPanelAlarmNow(): boolean {
    return Date.now() >= this.alarmPanelSilentUntilMs;
  }

  /** Extiende el silencio inicial si llegan lecturas tarde o en varios lotes. */
  private bumpAlarmPanelSilentGrace(ms: number): void {
    const until = Date.now() + ms;
    if (until > this.alarmPanelSilentUntilMs) {
      this.alarmPanelSilentUntilMs = until;
    }
  }

  private updateAlarmAccumulator(): void {
    const current = new Set(this.activeAlerts.map((a) => a.id));

    if (!this.panelAlarmSnapshotInitialized) {
      this.panelAlarmSnapshotInitialized = true;
      try {
        const raw = localStorage.getItem(this.panelAlertIdsStorageKey);
        if (raw) {
          const arr = JSON.parse(raw) as unknown;
          if (Array.isArray(arr)) {
            this.lastActiveAlertIds = new Set(arr.filter((x) => typeof x === 'string'));
            /** Nueva instancia del panel (p. ej. /dashboard → /configuracion): no arrastrar el cooldown del pitido repetido ni ejecutar repeat en esta misma pasada. */
            this.lastAlarmToneAtMs = Date.now();
            this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
            return;
          } else {
            this.lastActiveAlertIds = new Set(current);
            this.lastAlarmToneAtMs = Date.now();
            this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
            this.persistPanelAlertIdsSnapshot(current);
            return;
          }
        } else {
          this.lastActiveAlertIds = new Set(current);
          this.lastAlarmToneAtMs = Date.now();
          this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
          this.persistPanelAlertIdsSnapshot(current);
          return;
        }
      } catch {
        this.lastActiveAlertIds = new Set(current);
        this.lastAlarmToneAtMs = Date.now();
        this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
        this.persistPanelAlertIdsSnapshot(current);
        return;
      }
    }

    if (this.devices.length === 0) {
      return;
    }

    if (!this.readingsHydrationDone && this.readings.length > 0) {
      this.readingsHydrationDone = true;
      this.lastActiveAlertIds = new Set(current);
      this.lastAlarmToneAtMs = Date.now();
      this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
      this.persistPanelAlertIdsSnapshot(current);
      this.panelAlarmBaselineSeeded = true;
      this.alarmRepeatAnchorDone = true;
      this.bumpAlarmPanelSilentGrace(5000);
      return;
    }

    if (
      !this.panelAlarmBaselineSeeded &&
      this.lastActiveAlertIds.size === 0 &&
      current.size > 0
    ) {
      this.panelAlarmBaselineSeeded = true;
      this.lastActiveAlertIds = new Set(current);
      this.lastAlarmToneAtMs = Date.now();
      this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
      this.persistPanelAlertIdsSnapshot(current);
      return;
    }

    const newIds: string[] = [];
    for (const id of current) {
      if (!this.lastActiveAlertIds.has(id)) newIds.push(id);
    }
    if (newIds.length > 0 && this.shouldPlayPanelAlarmNow()) {
      this.alarmEventsCount += newIds.length;
      this.persistAlarmEventsCount();
      this.playAlarmTone();
      this.tryBrowserNotification(newIds);
    }

    if (!this.alarmRepeatAnchorDone && this.devices.length > 0) {
      this.alarmRepeatAnchorDone = true;
      if (newIds.length === 0) {
        this.lastAlarmToneAtMs = Date.now();
        this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
      }
    }

    if (current.size > 0) {
      const now = Date.now();
      const cooldownMs = this.panelAlarmRepeatCooldownMs();
      if (now - this.lastAlarmToneAtMs >= cooldownMs && this.shouldPlayPanelAlarmNow()) {
        this.playAlarmTone();
      }
    }

    const skipPersistEmptyWhileNoReadings =
      current.size === 0 && this.readings.length === 0 && this.devices.length > 0;
    if (!skipPersistEmptyWhileNoReadings) {
      this.lastActiveAlertIds = current;
      this.persistPanelAlertIdsSnapshot(current);
    }
  }

  /** Retardo de pitido/notificación según tipo de alerta (temp vs desconectado). */
  private panelAlarmCooldownMsForDeviceAndKind(
    deviceId: string | null,
    kind: DashboardAlertKind
  ): number {
    const minMs = 60 * 1000;
    const defaultMs = 15 * 60 * 1000;
    if (!deviceId) return defaultMs;
    const dev = this.devices.find((x) => x.id === deviceId);
    if (!dev) return defaultMs;
    if (kind === 'offline') {
      const offMs = dev.offlinePushCooldownMs;
      if (typeof offMs === 'number' && Number.isFinite(offMs) && offMs > 0) {
        return Math.max(minMs, offMs);
      }
      const tms = dev.tempPushCooldownMs;
      if (typeof tms === 'number' && Number.isFinite(tms) && tms > 0) {
        return Math.max(minMs, tms);
      }
      return defaultMs;
    }
    const tms = dev.tempPushCooldownMs;
    if (typeof tms === 'number' && Number.isFinite(tms) && tms > 0) {
      return Math.max(minMs, tms);
    }
    return defaultMs;
  }

  /** El intervalo más largo entre pitidos mientras sigue alguna alerta (varias alertas ⇒ el mayor retardo). */
  private panelAlarmRepeatCooldownMs(): number {
    const defaultMs = 15 * 60 * 1000;
    let maxCd = 0;
    for (const a of this.activeAlerts) {
      const did = this.deviceIdFromAlertId(a.id);
      const cd = this.panelAlarmCooldownMsForDeviceAndKind(did, a.kind);
      maxCd = Math.max(maxCd, cd);
    }
    return maxCd > 0 ? maxCd : defaultMs;
  }

  private deviceIdFromAlertId(alertId: string): string | null {
    const suf = [
      '-t1-high',
      '-t1-low',
      '-t2-high',
      '-t2-low',
      '-offline',
      '-current',
      '-power',
      '-crit',
      '-low',
    ];
    for (const s of suf) {
      if (alertId.endsWith(s)) return alertId.slice(0, -s.length);
    }
    return null;
  }

  private persistPanelAlertIdsSnapshot(current: Set<string>): void {
    try {
      localStorage.setItem(this.panelAlertIdsStorageKey, JSON.stringify([...current]));
    } catch {
      /* */
    }
  }

  private persistLastAlarmToneAtMs(ms: number): void {
    try {
      localStorage.setItem(this.panelLastAlarmToneAtStorageKey, String(ms));
    } catch {
      /* */
    }
  }

  private loadAlarmEventsCount(): number {
    try {
      const raw = localStorage.getItem(this.alarmsCountStorageKey);
      if (!raw) return 0;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private persistAlarmEventsCount(): void {
    try {
      localStorage.setItem(this.alarmsCountStorageKey, String(this.alarmEventsCount));
    } catch {
      // no-op
    }
  }

  private tryBrowserNotification(newAlertIds: string[]): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (newAlertIds.length === 0) return;

    void (async () => {
      let perm = Notification.permission;
      if (perm === 'default') {
        perm = await Notification.requestPermission();
      }
      if (perm !== 'granted') return;

      const byId = new Map(this.activeAlerts.map((a) => [a.id, a]));
      for (const alertId of newAlertIds) {
        const al = byId.get(alertId);
        if (!al) continue;
        const did = this.deviceIdFromAlertId(alertId);
        const cooldownMs = this.panelAlarmCooldownMsForDeviceAndKind(did, al.kind);
        try {
          const key = `ar_browser_notif_${alertId}`;
          const raw = sessionStorage.getItem(key);
          const last = raw ? Number.parseInt(raw, 10) : 0;
          if (Number.isFinite(last) && last > 0 && Date.now() - last < cooldownMs) {
            continue;
          }
          sessionStorage.setItem(key, String(Date.now()));
        } catch {
          /* seguir: no bloquear notificación */
        }
        let title = 'Alarma';
        if (al.kind === 'offline') {
          title = `${al.deviceName}: desconectado`;
        } else if (al.kind === 'temp_high') {
          title = `${al.deviceName}: temperatura alta`;
        } else if (al.kind === 'temp_low') {
          title = `${al.deviceName}: temperatura baja`;
        } else if (al.kind === 'current_high') {
          title = `${al.deviceName}: corriente alta`;
        }
        const body = al.detail ? `${al.message}\n${al.detail}` : al.message;
        try {
          new Notification(title, { body, tag: al.id });
        } catch {
          // no-op
        }
      }
    })();
  }

  /** Fecha/hora en zona Argentina (alineado con textos de push). */
  formatFullDateTime(ms: number): string {
    return new Date(ms).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
  }

  loadAlarmSoundPreset(): void {
    try {
      const v = localStorage.getItem(this.alarmSoundStorageKey);
      if (v === 'buzzer' || v === 'chime' || v === 'low' || v === 'classic') {
        this.alarmSoundPreset = v;
        return;
      }
    } catch {
      /* */
    }
    this.alarmSoundPreset = 'classic';
  }

  onAlarmSoundPresetChange(): void {
    try {
      localStorage.setItem(this.alarmSoundStorageKey, this.alarmSoundPreset);
    } catch {
      /* */
    }
  }

  previewAlarmSound(): void {
    this.playAlarmTone();
  }

  private pickAlarmContext(): 'offline' | 'temp_hot' | 'temp_cold' {
    if (this.activeAlerts.some((a) => a.kind === 'offline')) return 'offline';
    if (this.activeAlerts.some((a) => a.kind === 'temp_high' || a.kind === 'current_high'))
      return 'temp_hot';
    if (this.activeAlerts.some((a) => a.kind === 'temp_low')) return 'temp_cold';
    return 'temp_hot';
  }

  private beep(
    ctx: AudioContext,
    start: number,
    freq: number,
    type: OscillatorType,
    durSec: number,
    gainPeak: number
  ): void {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.exponentialRampToValueAtTime(Math.max(gainPeak, 0.0002), start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + durSec);
    o.start(start);
    o.stop(start + durSec + 0.04);
  }

  private scheduleAlarmPattern(
    ctx: AudioContext,
    preset: AlarmSoundPreset,
    alarmCtx: 'offline' | 'temp_hot' | 'temp_cold'
  ): void {
    const t0 = ctx.currentTime;
    const scale =
      alarmCtx === 'offline' ? 0.72 : alarmCtx === 'temp_cold' ? 0.88 : 1;

    switch (preset) {
      case 'classic':
        this.beep(ctx, t0, 1046 * scale, 'sine', 0.38, 0.12);
        break;
      case 'low':
        this.beep(ctx, t0, 196 * scale, 'sine', 0.58, 0.09);
        break;
      case 'buzzer':
        this.beep(ctx, t0, 440, 'square', 0.14, 0.11);
        this.beep(ctx, t0 + 0.2, 880, 'square', 0.14, 0.11);
        if (alarmCtx === 'offline') {
          this.beep(ctx, t0 + 0.42, 330, 'square', 0.22, 0.1);
        }
        break;
      case 'chime': {
        const freqs = [523.25, 659.25, 783.99].map((f) => f * scale);
        let t = t0;
        for (const f of freqs) {
          this.beep(ctx, t, f, 'triangle', 0.24, 0.065);
          t += 0.28;
        }
        break;
      }
      default:
        this.beep(ctx, t0, 1046, 'sine', 0.38, 0.12);
    }
  }

  private playAlarmTone(): void {
    if (typeof window === 'undefined') return;
    const Ctx = (window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctx) return;
    try {
      const ctx = this.audioCtx ?? new Ctx();
      this.audioCtx = ctx;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      const alarmCtx = this.pickAlarmContext();
      this.scheduleAlarmPattern(ctx, this.alarmSoundPreset, alarmCtx);
      this.lastAlarmToneAtMs = Date.now();
      this.persistLastAlarmToneAtMs(this.lastAlarmToneAtMs);
    } catch {
      // no-op
    }
  }

  equipmentSheetAvailable(): boolean {
    return (
      this.environment.deviceCloudSync &&
      !!this.selectedDeviceId &&
      this.isUuidDeviceId(this.selectedDeviceId)
    );
  }

  /** Recarga fichas tras sincronizar ruta/query/dispositivo (debounce para no duplicar peticiones). */
  private scheduleEquipmentPageReload(): void {
    if (this.equipmentPageReloadTimer != null) {
      clearTimeout(this.equipmentPageReloadTimer);
    }
    this.equipmentPageReloadTimer = setTimeout(() => {
      this.equipmentPageReloadTimer = null;
      if (this.router.url.split('?')[0] !== '/ficha-equipo') return;
      if (!this.equipmentSheetAvailable() || !this.selectedDeviceId) return;
      void this.loadEquipmentPage();
    }, 120);
  }

  private isUuidDeviceId(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id
    );
  }

  /** Ficha técnica en la nube solo para equipos con UUID de panel. */
  deviceCanOpenEquipmentSheet(device: DashboardDevice): boolean {
    return this.environment.deviceCloudSync && this.isUuidDeviceId(device.id);
  }

  goToEquipmentSheet(deviceId: string, e?: Event): void {
    e?.stopPropagation();
    void this.router.navigate(['/ficha-equipo'], {
      queryParams: { deviceId },
      replaceUrl: true,
    });
  }

  async loadEquipmentPage(): Promise<void> {
    if (!this.equipmentSheetAvailable()) {
      this.equipmentFichas = [];
      this.selectedFichaId = null;
      this.equipmentLogRows = [];
      this.equipmentPhotos = [];
      return;
    }
    const id = this.selectedDeviceId as string;
    this.equipmentLoading = true;
    this.equipmentFeedback = '';
    try {
      let { rows: fichas, error: errFichas } = await this.equipmentSheet.listFichas(id);
      if (errFichas) {
        this.equipmentFichas = [];
        this.selectedFichaId = null;
        const low = errFichas.toLowerCase();
        this.equipmentFeedback =
          low.includes('does not exist') ||
          low.includes('schema cache') ||
          low.includes('could not find') ||
          low.includes('device_equipment_fichas')
            ? 'Ejecutá en Supabase el SQL: 021_device_equipment_ficha.sql y 022_device_equipment_fichas.sql'
            : errFichas;
        return;
      }
      if (!fichas.length) {
        this.equipmentFichas = [];
        this.selectedFichaId = null;
        this.hydrateEquipmentFormsFromFicha(null);
        await this.loadEquipmentLogsAndPhotos();
        void this.notifyMaintenanceForAllFichasIfDue([]);
        return;
      }
      this.equipmentFichas = fichas;
      if (!this.selectedFichaId || !fichas.some((f) => f.id === this.selectedFichaId)) {
        this.selectedFichaId = fichas[0]?.id ?? null;
      }
      const active = fichas.find((f) => f.id === this.selectedFichaId) ?? fichas[0];
      this.hydrateEquipmentFormsFromFicha(active ?? null);
      await this.loadEquipmentLogsAndPhotos();
      const fid = this.selectedFichaId;
      if (fid && fid !== this.lastEquipmentLogFichaId) {
        this.lastEquipmentLogFichaId = fid;
        this.initLogDateTimeDefaults();
      }
      void this.notifyMaintenanceForAllFichasIfDue(fichas);
    } finally {
      this.equipmentLoading = false;
    }
  }

  async onEquipmentFichaChange(fichaId: string): Promise<void> {
    this.selectedFichaId = fichaId;
    this.equipmentNewFichaHint = '';
    this.lastEquipmentLogFichaId = fichaId;
    const f = this.equipmentFichas.find((x) => x.id === fichaId);
    if (f) {
      this.hydrateEquipmentFormsFromFicha(f);
    }
    await this.loadEquipmentLogsAndPhotos();
    this.initLogDateTimeDefaults();
  }

  compareFichaId(a: string | null | undefined, b: string | null | undefined): boolean {
    return a === b;
  }

  trackByFichaId(_i: number, f: DeviceEquipmentFichaRow): string {
    return f.id;
  }

  trackByDeviceId(_i: number, d: DashboardDevice): string {
    return d.id;
  }

  /** True si hay al menos un dato técnico guardado (el nombre solo no alcanza). */
  equipmentFichaHasTechnicalContent(f: DeviceEquipmentFichaRow): boolean {
    const t = (s: string | null | undefined) => (s?.trim() ?? '') !== '';
    if (t(f.compressorText)) return true;
    if (f.hp != null && Number.isFinite(f.hp)) return true;
    if (t(f.refrigerant)) return true;
    if (t(f.condenserCoolingType)) return true;
    if (f.condenserFanCount != null && Number.isFinite(f.condenserFanCount)) return true;
    if (t(f.condenserBladeDiameterText)) return true;
    if (t(f.condenserFanMotorPhases)) return true;
    if (t(f.condenserFanCapacitorUf)) return true;
    if (t(f.condenserNotes)) return true;
    if (t(f.expansionType)) return true;
    if (t(f.expansionCapillaryMeasure)) return true;
    if (t(f.expansionValveBrand)) return true;
    if (t(f.expansionValveModel)) return true;
    if (t(f.evaporatorAirType)) return true;
    if (f.evaporatorFanCount != null && Number.isFinite(f.evaporatorFanCount)) return true;
    if (t(f.evaporatorFanMotorPhases)) return true;
    if (t(f.evaporatorFanSinglePhaseDetail)) return true;
    if (t(f.evaporatorNotes)) return true;
    if (t(f.supply)) return true;
    if (f.pumpDown) return true;
    if (t(f.defrost)) return true;
    if (t(f.chamberType)) return true;
    if (t(f.freeNotes)) return true;
    if (f.lastMaintenanceAt) return true;
    if (f.nextMaintenanceAt) return true;
    if (f.maintenanceIntervalDays != null && Number.isFinite(f.maintenanceIntervalDays)) return true;
    return false;
  }

  get equipmentFichasWithTechnicalCards(): DeviceEquipmentFichaRow[] {
    return this.equipmentFichas.filter((f) => this.equipmentFichaHasTechnicalContent(f));
  }

  /** Ficha seleccionada existe pero aún sin datos técnicos (solo borrar o completar). */
  get selectedFichaWithoutTechnicalContent(): boolean {
    if (!this.selectedFichaId) return false;
    const f = this.equipmentFichas.find((x) => x.id === this.selectedFichaId);
    return !!f && !this.equipmentFichaHasTechnicalContent(f);
  }

  /** Una línea corta para la tarjeta (compresor o refrigerante). */
  equipmentFichaCardSubtitle(f: DeviceEquipmentFichaRow): string {
    const c = f.compressorText?.trim();
    if (c) return c.length > 52 ? `${c.slice(0, 50)}…` : c;
    const r = f.refrigerant?.trim();
    if (r) return `Ref. ${r}`;
    const fn = f.freeNotes?.trim();
    if (fn) return fn.length > 52 ? `${fn.slice(0, 50)}…` : fn;
    return 'Ver y editar datos';
  }

  scrollToEquipmentFichaEditor(): void {
    const el =
      typeof document !== 'undefined'
        ? document.getElementById('equipment-ficha-editor')
        : null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  onEquipmentSavedCardClick(): void {
    this.scrollToEquipmentFichaEditor();
  }

  dismissEquipmentSavedCard(): void {
    if (this.equipmentSavedCardTimer != null) {
      clearTimeout(this.equipmentSavedCardTimer);
      this.equipmentSavedCardTimer = null;
    }
    this.equipmentSavedCard = null;
  }

  /** Fecha de último guardado de la ficha seleccionada (nube). */
  selectedFichaUpdatedAtLabel(): string {
    const f = this.equipmentFichas.find((x) => x.id === this.selectedFichaId);
    if (!f?.updatedAt) return '';
    try {
      return new Date(f.updatedAt).toLocaleString('es-AR');
    } catch {
      return '';
    }
  }

  private async loadEquipmentLogsAndPhotos(): Promise<void> {
    const devId = this.selectedDeviceId;
    const fid = this.selectedFichaId;
    if (!devId || !fid) {
      this.equipmentLogRows = [];
      this.equipmentPhotos = [];
      return;
    }
    const { rows: logs, error: errLog } = await this.equipmentSheet.listLog(devId, fid);
    this.equipmentLogRows = errLog ? [] : logs;
    if (errLog && !this.equipmentFeedback) {
      this.equipmentFeedback = errLog;
    }
    const { rows: photos, error: errPh } = await this.equipmentSheet.listPhotos(devId, fid);
    this.equipmentPhotos = errPh ? [] : photos;
    if (errPh && !this.equipmentFeedback) {
      this.equipmentFeedback = errPh;
    }
  }

  async addEquipmentFicha(): Promise<void> {
    if (!this.equipmentSheetAvailable() || !this.selectedDeviceId) return;
    const n = this.equipmentFichas.length + 1;
    const label = `Cámara ${n}`;
    const { id, error } = await this.equipmentSheet.createFicha(this.selectedDeviceId, label);
    if (error || !id) {
      this.equipmentFeedback = error ?? 'No se pudo agregar la ficha.';
      return;
    }
    this.selectedFichaId = id;
    this.equipmentNewFichaHint =
      'Estás en una ficha nueva: completá los datos y tocá Guardar. El PDF puede incluir alarmas y tabla de lecturas (opciones abajo).';
    void this.loadEquipmentPage();
  }

  async deleteEquipmentFicha(): Promise<void> {
    const fid = this.selectedFichaId;
    if (!fid || !this.selectedDeviceId) return;
    const isLast = this.equipmentFichas.length <= 1;
    const msg = isLast
      ? '¿Eliminar esta ficha? El equipo quedará sin fichas hasta que agregues una nueva.'
      : '¿Eliminar esta ficha junto con su bitácora y fotos de esta ficha?';
    if (!confirm(msg)) return;
    const { error } = await this.equipmentSheet.deleteFicha(fid);
    if (error) {
      this.equipmentFeedback = error;
      return;
    }
    this.selectedFichaId = null;
    this.equipmentNewFichaHint = '';
    void this.loadEquipmentPage();
  }

  private hydrateEquipmentFormsFromFicha(row: DeviceEquipmentFichaRow | null): void {
    if (!row) {
      this.eqFichaLabelForm = '';
      this.eqCompressorForm = '';
      this.eqHpForm = '';
      this.eqRefrigerantForm = '';
      this.eqCondenserCoolingForm = '';
      this.eqCondenserFanCountForm = '';
      this.eqCondenserBladeForm = '';
      this.eqCondenserFanPhasesForm = '';
      this.eqCondenserCapacitorForm = '';
      this.eqCondenserNotesForm = '';
      this.eqExpansionTypeForm = '';
      this.eqExpansionCapillaryForm = '';
      this.eqExpansionValveBrandForm = '';
      this.eqExpansionValveModelForm = '';
      this.eqEvapAirTypeForm = '';
      this.eqEvapFanCountForm = '';
      this.eqEvapFanPhasesForm = '';
      this.eqEvapSingleDetailForm = '';
      this.eqEvapNotesForm = '';
      this.eqSupplyForm = '';
      this.eqPumpDownForm = false;
      this.eqDefrostForm = '';
      this.eqChamberForm = '';
      this.eqFreeNotesForm = '';
      this.eqLastMaintDate = '';
      this.eqLastMaintTime = '';
      this.eqNextMaintDate = '';
      this.eqNextMaintTime = '';
      this.eqMaintIntervalForm = '';
      this.eqMaintNotifyForm = true;
      return;
    }
    this.eqFichaLabelForm = row.label ?? '';
    this.eqCompressorForm = row.compressorText ?? '';
    this.eqHpForm = row.hp != null && Number.isFinite(row.hp) ? String(row.hp) : '';
    this.eqRefrigerantForm = row.refrigerant ?? '';
    this.eqCondenserCoolingForm = row.condenserCoolingType ?? '';
    this.eqCondenserFanCountForm =
      row.condenserFanCount != null && Number.isFinite(row.condenserFanCount)
        ? String(row.condenserFanCount)
        : '';
    this.eqCondenserBladeForm = row.condenserBladeDiameterText ?? '';
    this.eqCondenserFanPhasesForm = row.condenserFanMotorPhases ?? '';
    this.eqCondenserCapacitorForm = row.condenserFanCapacitorUf ?? '';
    this.eqCondenserNotesForm = row.condenserNotes ?? '';
    this.eqExpansionTypeForm = row.expansionType ?? '';
    this.eqExpansionCapillaryForm = row.expansionCapillaryMeasure ?? '';
    this.eqExpansionValveBrandForm = row.expansionValveBrand ?? '';
    this.eqExpansionValveModelForm = row.expansionValveModel ?? '';
    this.eqEvapAirTypeForm = row.evaporatorAirType ?? '';
    this.eqEvapFanCountForm =
      row.evaporatorFanCount != null && Number.isFinite(row.evaporatorFanCount)
        ? String(row.evaporatorFanCount)
        : '';
    this.eqEvapFanPhasesForm = row.evaporatorFanMotorPhases ?? '';
    this.eqEvapSingleDetailForm = row.evaporatorFanSinglePhaseDetail ?? '';
    this.eqEvapNotesForm = row.evaporatorNotes ?? '';
    this.eqSupplyForm = row.supply ?? '';
    this.eqPumpDownForm = row.pumpDown;
    this.eqDefrostForm = row.defrost ?? '';
    this.eqChamberForm = row.chamberType ?? '';
    this.eqFreeNotesForm = row.freeNotes ?? '';
    this.eqLastMaintDate = this.isoToDateInput(row.lastMaintenanceAt);
    this.eqLastMaintTime = this.isoToTimeInput(row.lastMaintenanceAt);
    this.eqNextMaintDate = this.isoToDateInput(row.nextMaintenanceAt);
    this.eqNextMaintTime = this.isoToTimeInput(row.nextMaintenanceAt);
    this.eqMaintIntervalForm =
      row.maintenanceIntervalDays != null && Number.isFinite(row.maintenanceIntervalDays)
        ? String(row.maintenanceIntervalDays)
        : '';
    this.eqMaintNotifyForm = row.maintenanceNotifyEnabled !== false;
  }

  private isoToDateInput(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private isoToTimeInput(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private combineDateTimeToIso(dateStr: string, timeStr: string): string | null {
    const d = dateStr.trim();
    if (!d) return null;
    const t = timeStr.trim() || '00:00';
    const iso = new Date(`${d}T${t}:00`);
    if (Number.isNaN(iso.getTime())) return null;
    return iso.toISOString();
  }

  private initLogDateTimeDefaults(): void {
    const now = new Date();
    this.logDateForm = this.isoToDateInput(now.toISOString());
    this.logTimeForm = this.isoToTimeInput(now.toISOString());
    this.logNoteForm = '';
  }

  async saveEquipmentSheet(): Promise<void> {
    if (!this.equipmentSheetAvailable() || !this.selectedFichaId) return;
    this.equipmentSaving = true;
    this.equipmentFeedback = '';
    try {
      const cur = this.equipmentFichas.find((f) => f.id === this.selectedFichaId);
      const hpRaw = this.eqHpForm.trim().replace(',', '.');
      const hp = hpRaw ? Number.parseFloat(hpRaw) : null;
      const intRaw = this.eqMaintIntervalForm.trim();
      const interval = intRaw ? Number.parseInt(intRaw, 10) : null;
      const cfc = this.eqCondenserFanCountForm.trim();
      const condFanCount = cfc ? Number.parseInt(cfc, 10) : null;
      const efc = this.eqEvapFanCountForm.trim();
      const evapFanCount = efc ? Number.parseInt(efc, 10) : null;
      const expT = this.eqExpansionTypeForm.trim();
      const expansionType = expT || null;
      const expansionCapillaryMeasure =
        expansionType === 'capillary' ? this.eqExpansionCapillaryForm.trim() || null : null;
      const expansionValveBrand =
        expansionType === 'valve' ? this.eqExpansionValveBrandForm.trim() || null : null;
      const expansionValveModel =
        expansionType === 'valve' ? this.eqExpansionValveModelForm.trim() || null : null;
      const { error } = await this.equipmentSheet.upsertFicha({
        id: this.selectedFichaId,
        deviceId: this.selectedDeviceId!,
        sortOrder: cur?.sortOrder ?? 0,
        label: this.eqFichaLabelForm.trim() || 'Sin nombre',
        compressorText: this.eqCompressorForm.trim() || null,
        hp: hp != null && Number.isFinite(hp) ? hp : null,
        refrigerant: this.eqRefrigerantForm.trim() || null,
        condenserCoolingType: this.eqCondenserCoolingForm.trim() || null,
        condenserFanCount: condFanCount != null && Number.isFinite(condFanCount) ? condFanCount : null,
        condenserBladeDiameterText: this.eqCondenserBladeForm.trim() || null,
        condenserFanMotorPhases: this.eqCondenserFanPhasesForm.trim() || null,
        condenserFanCapacitorUf: this.eqCondenserCapacitorForm.trim() || null,
        condenserNotes: this.eqCondenserNotesForm.trim() || null,
        expansionType,
        expansionCapillaryMeasure,
        expansionValveBrand,
        expansionValveModel,
        evaporatorAirType: this.eqEvapAirTypeForm.trim() || null,
        evaporatorFanCount: evapFanCount != null && Number.isFinite(evapFanCount) ? evapFanCount : null,
        evaporatorFanMotorPhases: this.eqEvapFanPhasesForm.trim() || null,
        evaporatorFanSinglePhaseDetail: this.eqEvapSingleDetailForm.trim() || null,
        evaporatorNotes: this.eqEvapNotesForm.trim() || null,
        supply: this.eqSupplyForm.trim() || null,
        pumpDown: this.eqPumpDownForm,
        defrost: this.eqDefrostForm.trim() || null,
        chamberType: this.eqChamberForm.trim() || null,
        freeNotes: this.eqFreeNotesForm.trim() || null,
        lastMaintenanceAt: this.combineDateTimeToIso(this.eqLastMaintDate, this.eqLastMaintTime),
        nextMaintenanceAt: this.combineDateTimeToIso(this.eqNextMaintDate, this.eqNextMaintTime),
        maintenanceIntervalDays:
          interval != null && Number.isFinite(interval) && interval > 0 ? interval : null,
        maintenanceNotifyEnabled: this.eqMaintNotifyForm,
      });
      if (error) {
        this.equipmentFeedback = error;
        return;
      }
      this.equipmentNewFichaHint = '';
      this.equipmentFeedback = '';
      const ts = new Date().toLocaleString('es-AR');
      const savedLabel = this.eqFichaLabelForm.trim() || 'Sin nombre';
      if (this.equipmentSavedCardTimer != null) {
        clearTimeout(this.equipmentSavedCardTimer);
        this.equipmentSavedCardTimer = null;
      }
      this.equipmentSavedCard = { label: savedLabel, at: ts };
      this.equipmentSavedCardTimer = window.setTimeout(() => {
        this.equipmentSavedCardTimer = null;
        this.equipmentSavedCard = null;
      }, 12000);
      const { rows: refreshed } = await this.equipmentSheet.listFichas(this.selectedDeviceId!);
      if (refreshed.length) {
        this.equipmentFichas = refreshed;
        const active = refreshed.find((f) => f.id === this.selectedFichaId) ?? refreshed[0];
        if (active) {
          this.hydrateEquipmentFormsFromFicha(active);
        }
        void this.notifyMaintenanceForAllFichasIfDue(refreshed);
      }
      this.initLogDateTimeDefaults();
    } finally {
      this.equipmentSaving = false;
    }
  }

  /** Mantenimiento: notificación en celular (Service Worker) o navegador; una vez por día por ficha. */
  private async notifyMaintenanceForAllFichasIfDue(fichas: DeviceEquipmentFichaRow[]): Promise<void> {
    if (typeof window === 'undefined') return;
    const devName = this.selectedDevice?.name ?? 'Equipo';
    const now = Date.now();
    const dayKey = this.isoToDateInput(new Date(now).toISOString());

    for (const f of fichas) {
      if (!f.maintenanceNotifyEnabled) continue;
      const next = f.nextMaintenanceAt ? new Date(f.nextMaintenanceAt).getTime() : NaN;
      if (!Number.isFinite(next)) continue;
      if (next > now + 48 * 3600 * 1000) continue;

      const storageKey = `ar_maint_ficha_${f.id}_${dayKey}`;
      try {
        if (localStorage.getItem(storageKey)) continue;
      } catch {
        /* */
      }

      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      const perm =
        'Notification' in window
          ? Notification.permission
          : 'denied' as globalThis.NotificationPermission;
      if (perm !== 'granted') continue;

      const overdue = next < now;
      const title = 'Mantenimiento AR Monitoreo';
      const body = overdue
        ? `${devName} · ${f.label}: fecha de mantenimiento vencida.`
        : `${devName} · ${f.label}: mantenimiento en las próximas 48 h.`;

      await this.showMaintenanceSystemNotification(title, body, `maint-ficha-${f.id}`);
      try {
        localStorage.setItem(storageKey, '1');
      } catch {
        /* */
      }
    }
  }

  private async showMaintenanceSystemNotification(
    title: string,
    body: string,
    tag: string
  ): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(title, {
          body,
          tag,
          icon: `${window.location.origin}/assets/icons/icon-192.svg`,
          vibrate: [120, 80, 120],
        });
        return;
      }
    } catch {
      /* */
    }
    try {
      new Notification(title, { body, tag });
    } catch {
      /* */
    }
  }

  async addEquipmentLogEntry(): Promise<void> {
    if (!this.equipmentSheetAvailable() || !this.selectedFichaId) return;
    const note = this.logNoteForm.trim();
    if (!note) {
      this.equipmentFeedback = 'Escribí una observación para la bitácora.';
      return;
    }
    const iso = this.combineDateTimeToIso(this.logDateForm, this.logTimeForm);
    if (!iso) {
      this.equipmentFeedback = 'Revisá fecha y hora de la bitácora.';
      return;
    }
    const { error } = await this.equipmentSheet.insertLog(
      this.selectedDeviceId!,
      this.selectedFichaId,
      iso,
      note
    );
    if (error) {
      this.equipmentFeedback = error;
      return;
    }
    this.equipmentFeedback = 'Entrada agregada a la bitácora.';
    window.setTimeout(() => {
      this.equipmentFeedback = '';
    }, 3000);
    void this.loadEquipmentPage();
  }

  async deleteEquipmentLogEntry(row: DeviceEquipmentLogRow): Promise<void> {
    if (!confirm('¿Eliminar esta entrada de la bitácora?')) return;
    const { error } = await this.equipmentSheet.deleteLog(row.id);
    if (error) {
      this.equipmentFeedback = error;
      return;
    }
    void this.loadEquipmentPage();
  }

  async onEquipmentPhotoSelected(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.equipmentSheetAvailable() || !this.selectedFichaId) return;
    this.equipmentPhotoUploading = true;
    this.equipmentFeedback = '';
    try {
      const cap = this.photoCaptionForm.trim() || null;
      const { error } = await this.equipmentSheet.uploadPhoto(
        this.selectedDeviceId!,
        this.selectedFichaId,
        file,
        cap
      );
      if (error) {
        this.equipmentFeedback = error;
        return;
      }
      this.photoCaptionForm = '';
      void this.loadEquipmentPage();
    } finally {
      this.equipmentPhotoUploading = false;
    }
  }

  async deleteEquipmentPhoto(p: DeviceEquipmentPhotoRow): Promise<void> {
    if (!confirm('¿Quitar esta foto?')) return;
    const { error } = await this.equipmentSheet.deletePhoto(p);
    if (error) {
      this.equipmentFeedback = error;
      return;
    }
    void this.loadEquipmentPage();
  }

  equipmentMaintenanceStatusLabel(): string {
    const next = this.combineDateTimeToIso(this.eqNextMaintDate, this.eqNextMaintTime);
    if (!next) return '';
    const t = new Date(next).getTime();
    if (Number.isNaN(t)) return '';
    if (t < Date.now()) return 'vencido';
    if (t < Date.now() + 72 * 3600 * 1000) return 'próximo';
    return '';
  }

  async exportEquipmentPdf(): Promise<void> {
    if (!this.equipmentSheetAvailable() || !this.selectedDevice) return;
    if (this.equipmentPdfIncludeChart) {
      const ok = window.confirm(
        'Vas a incluir un gráfico de temperatura y corriente en el PDF. ' +
          'Revisá el rango Desde / Hasta (vacío = últimos 7 días). ¿Continuar?'
      );
      if (!ok) return;
    }
    if (this.equipmentPdfIncludeChart && !this.equipmentChartRangeBounds()) {
      alert('Revisá las fechas del gráfico: “Desde” no puede ser posterior a “Hasta”.');
      return;
    }
    this.equipmentPdfExporting = true;
    this.equipmentFeedback = '';
    try {
      const [jspdfMod] = await Promise.all([import('jspdf')]);
      const JsPDF = jspdfMod.default;
      const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const dev = this.selectedDevice;
      const devId = dev.id;
      const { rows: allFichas, error: fe } = await this.equipmentSheet.listFichas(devId);
      if (fe || !allFichas.length) {
        this.equipmentFeedback = fe ?? 'No hay fichas para exportar.';
        return;
      }

      let y = 14;
      doc.setFontSize(14);
      doc.text('AR Monitoreo — Ficha del equipo', 14, y);
      y += 8;
      doc.setFontSize(10);
      doc.text(`Dispositivo: ${dev.name}`, 14, y);
      y += 6;
      doc.setFontSize(8);
      doc.setTextColor(80);
      doc.text(`Generado: ${new Date().toLocaleString('es-AR')}`, 14, y);
      doc.setTextColor(0);
      y += 10;

      const pushLine = (lines: string[], label: string, val: string | null | undefined) => {
        if (val != null && String(val).trim()) {
          lines.push(`${label}: ${String(val).trim()}`);
        }
      };

      for (const ficha of allFichas) {
        if (y > 250) {
          doc.addPage();
          y = 14;
        }
        doc.setFontSize(11);
        doc.setTextColor(30, 64, 175);
        doc.text(`Ficha: ${ficha.label}`, 14, y);
        doc.setTextColor(0);
        y += 7;

        const lines: string[] = [];
        pushLine(lines, 'Compresor', ficha.compressorText);
        if (ficha.hp != null && Number.isFinite(ficha.hp)) {
          pushLine(lines, 'HP', String(ficha.hp));
        }
        pushLine(lines, 'Refrigerante', ficha.refrigerant);
        const ct = ficha.condenserCoolingType;
        if (ct === 'forced_air') {
          pushLine(lines, 'Condensador', 'Ventilación forzada');
          if (ficha.condenserFanCount != null) {
            pushLine(lines, '  Cant. forzadores', String(ficha.condenserFanCount));
          }
          pushLine(lines, '  Ø palas / medida', ficha.condenserBladeDiameterText);
          pushLine(
            lines,
            '  Motor forzadores',
            ficha.condenserFanMotorPhases === 'three_phase'
              ? 'Trifásico'
              : ficha.condenserFanMotorPhases === 'single_phase'
                ? 'Monofásico'
                : ''
          );
          if (ficha.condenserFanMotorPhases === 'single_phase') {
            pushLine(lines, '  Capacitor (µF)', ficha.condenserFanCapacitorUf);
          }
        } else if (ct === 'water') {
          pushLine(lines, 'Condensador', 'Enfriado por agua');
        }
        pushLine(lines, 'Notas condensador', ficha.condenserNotes);

        const ext = ficha.expansionType;
        if (ext === 'capillary') {
          pushLine(lines, 'Expansión', 'Capilar');
          pushLine(lines, '  Medida', ficha.expansionCapillaryMeasure);
        } else if (ext === 'valve') {
          pushLine(lines, 'Expansión', 'Válvula');
          pushLine(lines, '  Marca', ficha.expansionValveBrand);
          pushLine(lines, '  Modelo', ficha.expansionValveModel);
        }

        const eat = ficha.evaporatorAirType;
        if (eat === 'static') {
          pushLine(lines, 'Evaporador', 'Estático (sin forzadores)');
        } else if (eat === 'forced') {
          pushLine(lines, 'Evaporador', 'Con forzadores');
          if (ficha.evaporatorFanCount != null) {
            pushLine(lines, '  Cantidad forzadores', String(ficha.evaporatorFanCount));
          }
          pushLine(
            lines,
            '  Alimentación motores',
            ficha.evaporatorFanMotorPhases === 'three_phase'
              ? 'Trifásico'
              : ficha.evaporatorFanMotorPhases === 'single_phase'
                ? 'Monofásico'
                : ''
          );
          if (ficha.evaporatorFanMotorPhases === 'single_phase') {
            pushLine(lines, '  Capacitor / detalle monofásico', ficha.evaporatorFanSinglePhaseDetail);
          }
        }
        pushLine(lines, 'Notas evaporador', ficha.evaporatorNotes);

        pushLine(lines, 'Alimentación (general)', ficha.supply);
        lines.push(`Pump down: ${ficha.pumpDown ? 'Sí' : 'No'}`);
        pushLine(lines, 'Descongelamiento', ficha.defrost);
        pushLine(lines, 'Tipo de cámara', ficha.chamberType);
        if (ficha.freeNotes?.trim()) {
          lines.push(`Descripción: ${ficha.freeNotes.trim()}`);
        }
        pushLine(
          lines,
          'Último mantenimiento',
          ficha.lastMaintenanceAt
            ? new Date(ficha.lastMaintenanceAt).toLocaleString('es-AR')
            : ''
        );
        pushLine(
          lines,
          'Próximo mantenimiento',
          ficha.nextMaintenanceAt
            ? new Date(ficha.nextMaintenanceAt).toLocaleString('es-AR')
            : ''
        );
        if (ficha.maintenanceIntervalDays != null) {
          pushLine(lines, 'Intervalo (días)', String(ficha.maintenanceIntervalDays));
        }
        pushLine(
          lines,
          'Última actualización (nube)',
          ficha.updatedAt ? new Date(ficha.updatedAt).toLocaleString('es-AR') : ''
        );

        doc.setFontSize(9);
        for (const line of lines) {
          const parts = doc.splitTextToSize(line, 182);
          for (const p of parts) {
            if (y > 270) {
              doc.addPage();
              y = 14;
            }
            doc.text(p, 14, y);
            y += 4.5;
          }
          y += 1;
        }

        const { rows: logs } = await this.equipmentSheet.listLog(devId, ficha.id);
        y += 3;
        doc.setFontSize(10);
        doc.text(`Bitácora — ${ficha.label}`, 14, y);
        y += 6;
        doc.setFontSize(8);
        for (const log of [...logs].sort(
          (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
        )) {
          const dt = new Date(log.occurredAt).toLocaleString('es-AR');
          const block = `${dt} — ${log.note}`;
          const parts = doc.splitTextToSize(block, 182);
          for (const p of parts) {
            if (y > 270) {
              doc.addPage();
              y = 14;
            }
            doc.text(p, 14, y);
            y += 4;
          }
          y += 1;
        }

        const { rows: photos } = await this.equipmentSheet.listPhotos(devId, ficha.id);
        let imgY = y + 4;
        for (const ph of photos) {
          try {
            const dataUrl = await this.loadImageAsDataUrl(ph.publicUrl);
            if (!dataUrl) continue;
            const pageW = 180;
            const imgProps = doc.getImageProperties(dataUrl);
            const ratio = imgProps.height / imgProps.width;
            const h = Math.min(90, pageW * ratio);
            if (imgY + h > 280) {
              doc.addPage();
              imgY = 14;
            }
            doc.addImage(dataUrl, 'JPEG', 14, imgY, pageW, h, undefined, 'FAST');
            imgY += h + 4;
            if (ph.caption?.trim()) {
              doc.setFontSize(7);
              doc.setTextColor(80);
              doc.text(ph.caption.trim(), 14, imgY);
              doc.setTextColor(0);
              imgY += 5;
            }
          } catch {
            /* */
          }
        }
        y = imgY + 8;
      }

      const { autoTable } = await import('jspdf-autotable');
      type DocWithAuto = typeof doc & { lastAutoTable?: { finalY: number } };
      let yPos = y;

      const bumpPageIfNeeded = (needMm: number): void => {
        if (yPos > 297 - needMm - 14) {
          doc.addPage();
          yPos = 14;
        }
      };

      if (this.equipmentPdfIncludeChart) {
        const chartPack = await this.readingsForEquipmentChart(devId);
        bumpPageIfNeeded(115);
        doc.setFontSize(11);
        doc.setTextColor(30, 64, 175);
        doc.text('Anexo: gráfico (temperatura / corriente)', 14, yPos);
        yPos += 7;
        doc.setFontSize(8);
        doc.setTextColor(80);
        if (chartPack.error) {
          doc.text(chartPack.error, 14, yPos);
          yPos += 8;
        } else {
          doc.text(`Rango: ${chartPack.rangeLabel}`, 14, yPos);
          yPos += 5;
          if (chartPack.rows.length < 2) {
            doc.text(
              'No hay suficientes lecturas en el rango para dibujar el gráfico (se necesitan al menos 2 puntos).',
              14,
              yPos
            );
            yPos += 10;
          }
        }
        doc.setTextColor(0);
        const chartImg =
          !chartPack.error && chartPack.rows.length >= 2
            ? this.renderEquipmentPdfChartDataUrl(
                chartPack.rows,
                dev,
                chartPack.rangeLabel,
                this.selectedSensor1Name,
                this.selectedSensor2Name
              )
            : null;
        if (chartImg) {
          const props = doc.getImageProperties(chartImg);
          const maxW = 182;
          let dispW = maxW;
          let dispH = (props.height * dispW) / props.width;
          if (yPos + dispH > 285) {
            doc.addPage();
            yPos = 14;
          }
          doc.addImage(chartImg, 'PNG', 14, yPos, dispW, dispH);
          yPos += dispH + 10;
        }
      }

      if (this.equipmentPdfIncludeReadings) {
        const annex = await this.readingsForEquipmentPdfAnnex(devId);
        bumpPageIfNeeded(50);
        doc.setFontSize(11);
        doc.setTextColor(30, 64, 175);
        doc.text('Anexo: lecturas (temperaturas y corriente, últimos 7 días)', 14, yPos);
        yPos += 7;
        doc.setFontSize(8);
        doc.setTextColor(80);
        const parts = doc.splitTextToSize(annex.note, 182);
        for (const p of parts) {
          doc.text(p, 14, yPos);
          yPos += 4;
        }
        doc.setTextColor(0);
        yPos += 2;
        if (annex.rows.length) {
          const s1 = this.selectedSensor1Name;
          const s2 = this.selectedSensor2Name;
          const nomV = dev.nominalVoltageV;
          const has2 = annex.rows.some((r) => r.temp2C != null && Number.isFinite(r.temp2C));
          const hasCurrent = annex.rows.some(
            (r) => effectiveCurrentAWithNominal(r, nomV) != null
          );
          const head: string[][] = [
            ['Fecha y hora', `${s1} (°C)`, ...(has2 ? [`${s2} (°C)`] : []), ...(hasCurrent ? ['Corriente (A)'] : [])],
          ];
          const body: string[][] = annex.rows.map((r) => {
            const row: string[] = [this.formatPdfDateTime(r.at), r.temperatureC.toFixed(1)];
            if (has2) {
              row.push(
                r.temp2C != null && Number.isFinite(r.temp2C) ? r.temp2C.toFixed(1) : '—'
              );
            }
            if (hasCurrent) {
              const ia = effectiveCurrentAWithNominal(r, nomV);
              row.push(ia != null && Number.isFinite(ia) ? ia.toFixed(2) : '—');
            }
            return row;
          });
          autoTable(doc, {
            startY: yPos,
            head,
            body,
            styles: { fontSize: 7, cellPadding: 1.5 },
            headStyles: { fillColor: [30, 58, 138], textColor: 255 },
            alternateRowStyles: { fillColor: [245, 247, 250] },
            margin: { left: 14, right: 14 },
          });
          yPos = (doc as DocWithAuto).lastAutoTable?.finalY ?? yPos + 30;
          yPos += 8;
        } else {
          doc.setFontSize(9);
          doc.text('Sin filas en el período o sin datos disponibles.', 14, yPos);
          yPos += 10;
        }
      }

      if (this.equipmentPdfIncludeAlarms) {
        await this.loadAlarmHistory();
        const evs = this.alarmHistoryItems
          .filter((e) => e.deviceId === devId)
          .sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime())
          .slice(0, 400);
        bumpPageIfNeeded(40);
        doc.setFontSize(11);
        doc.setTextColor(30, 64, 175);
        doc.text('Anexo: historial de alarmas (nube)', 14, yPos);
        yPos += 7;
        doc.setFontSize(8);
        doc.setTextColor(80);
        doc.text(
          evs.length
            ? `Últimos ${evs.length} eventos para este equipo (más recientes primero).`
            : 'Sin eventos registrados para este equipo o historial no disponible.',
          14,
          yPos
        );
        yPos += 6;
        doc.setTextColor(0);
        if (evs.length) {
          const head: string[][] = [['Fecha', 'Tipo', 'Mensaje']];
          const body: string[][] = evs.map((ev) => [
            this.formatPdfDateTime(ev.triggeredAt),
            this.alarmKindLabel(ev.kind),
            [ev.message, ev.detail].filter(Boolean).join(' — '),
          ]);
          autoTable(doc, {
            startY: yPos,
            head,
            body,
            styles: { fontSize: 7, cellPadding: 1.5 },
            headStyles: { fillColor: [30, 58, 138], textColor: 255 },
            alternateRowStyles: { fillColor: [245, 247, 250] },
            margin: { left: 14, right: 14 },
            columnStyles: { 2: { cellWidth: 95 } },
          });
        }
      }

      const safe = dev.name.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]+/gi, '_').replace(/_+/g, '_').slice(0, 48);
      doc.save(`ficha_equipo_${safe}_${this.pdfDateStamp()}.pdf`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.equipmentFeedback = `No se pudo generar el PDF: ${msg}`;
    } finally {
      this.equipmentPdfExporting = false;
    }
  }

  private loadImageAsDataUrl(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  private setupAlarmAudioUnlock(): void {
    if (typeof window === 'undefined') return;
    const Ctx = (window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctx) return;
    this.audioCtx = new Ctx();
    this.unlockAudioHandler = () => {
      if (this.audioCtx?.state === 'suspended') {
        void this.audioCtx.resume();
      }
      if (this.audioCtx?.state === 'running' && this.unlockAudioHandler) {
        window.removeEventListener('pointerdown', this.unlockAudioHandler);
        window.removeEventListener('keydown', this.unlockAudioHandler);
        this.unlockAudioHandler = null;
      }
    };
    window.addEventListener('pointerdown', this.unlockAudioHandler);
    window.addEventListener('keydown', this.unlockAudioHandler);
  }
}
