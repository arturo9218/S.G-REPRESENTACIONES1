import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { combineLatest, Subscription } from 'rxjs';
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
  HistoryListItem,
  TemperatureReading,
} from '../core/models/dashboard.models';
import { environment } from '../../environments/environment';
import { WebPushService, WebPushUiState } from '../core/web-push.service';
import { effectiveCurrentA } from '../core/reading.utils';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  readonly isDev = !environment.production;
  /** Expuesto al template (intervalo de actualización de lecturas). */
  readonly environment = environment;

  email: string | null = null;
  userInitial = '?';
  searchQuery = '';

  devices: DashboardDevice[] = [];
  readings: TemperatureReading[] = [];
  selectedDeviceId: string | null = null;
  alertsEnabledForm = true;
  tempLowForm = '';
  tempHighForm = '';
  tempPushDelayMinForm = '15';
  /** Retardo entre avisos de “desconectado” (min), independiente del de temperatura */
  offlinePushDelayMinForm = '15';
  /** Suma en °C al valor del ESP (corrección por sensor); se aplica en la nube al guardar lecturas. */
  temp1OffsetForm = '0';
  temp2OffsetForm = '0';
  temp3OffsetForm = '0';
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
  private subDev: Subscription | null = null;
  private subRead: Subscription | null = null;
  private routerSub: Subscription | null = null;
  private routeQuerySub: Subscription | null = null;
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

  private readonly chartStyleStorageKey = 'sg_chart_style_v1';
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
  shellRoute: 'dashboard' | 'devices' | 'alerts' | 'settings' = 'dashboard';
  alarmEventsCount = 0;
  private lastActiveAlertIds = new Set<string>();
  private lastAlarmToneAtMs = 0;
  /** Primera pasada: persistir snapshot sin sonar (evita pitido al recargar con las mismas alertas). */
  private panelAlarmSnapshotInitialized = false;
  /** Primera hidratación con dispositivos: si no había snapshot, alinear sin pitido (evita “todas nuevas”). */
  private panelAlarmBaselineSeeded = false;
  /** Primera pasada con datos: ancla el repeat para no sonar al entrar si el último pitido fue hace mucho. */
  private alarmRepeatAnchorDone = false;
  private readonly panelAlertIdsStorageKey = 'sg_panel_alert_ids_v1';
  /** Último pitido del panel (ms); respeta el retardo entre alertas al reabrir la app */
  private readonly panelLastAlarmToneAtStorageKey = 'sg_panel_last_alarm_tone_at_v1';
  private readonly alarmsCountStorageKey = 'sg_alarms_count_v1';
  private readonly alarmSoundStorageKey = 'sg_alarm_sound_v1';

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
    private readonly deviceStore: DeviceStoreService,
    private readonly webPush: WebPushService
  ) {
    void this.auth.getSession().then((s) => {
      this.email = s?.user.email ?? null;
      const mail = this.email ?? '';
      this.userInitial = mail ? mail.charAt(0).toUpperCase() : '?';
    });
  }

  ngOnInit(): void {
    this.syncShellRoute();
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.syncShellRoute());
    this.loadChartStylePreset();
    this.loadAlarmSoundPreset();
    void this.refreshWebPushUi();
    this.setupAlarmAudioUnlock();
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
    });
    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.devices = list;
      if (this.selectedDeviceId && !list.some((d) => d.id === this.selectedDeviceId)) {
        this.selectDevice(list[0]?.id ?? null, false);
        return;
      }
      this.syncNotificationFormWithSelected();
      this.updateAlarmAccumulator();
    });
    this.subRead = this.deviceStore.readings$.subscribe((list) => {
      this.readings = list;
      this.updateAlarmAccumulator();
    });
  }

  ngOnDestroy(): void {
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
    this.routerSub?.unsubscribe();
    this.routeQuerySub?.unsubscribe();
  }

  private syncShellRoute(): void {
    const path = this.router.url.split('?')[0];
    if (path === '/configuracion') {
      this.shellRoute = 'settings';
      void this.refreshWebPushUi();
      return;
    }
    if (path === '/dispositivos') {
      this.shellRoute = 'devices';
      return;
    }
    if (path === '/alertas') {
      this.shellRoute = 'alerts';
      return;
    }
    if (path === '/dashboard') {
      this.shellRoute = 'dashboard';
    }
  }

  get hasDevices(): boolean {
    return this.devices.length > 0;
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
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
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
    const latestByDevice = new Map<string, number>();
    for (const r of this.readings) {
      const t = new Date(r.at).getTime();
      if (!Number.isFinite(t)) continue;
      const prev = latestByDevice.get(r.deviceId);
      if (prev == null || t > prev) latestByDevice.set(r.deviceId, t);
    }

    for (const d of this.devices) {
      /** Solo si está explícitamente en false se silencian alarmas y notificaciones del navegador. */
      const alertsOn = d.alertsEnabled !== false;

      const latestAt = latestByDevice.get(d.id);
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

      const t = d.temperatureC;
      if (t == null || d.alertsEnabled === false) continue;
      const low = d.tempLowC ?? null;
      const high = d.tempHighC ?? null;
      const readingLabel =
        latestAt != null
          ? `Medición: ${this.formatFullDateTime(latestAt)}`
          : `Ahora: ${this.formatFullDateTime(nowMs)}`;
      if (high != null && t >= high) {
        out.push({
          id: `${d.id}-crit`,
          deviceName: d.name,
          temperatureC: t,
          message: 'Temperatura por encima del umbral',
          detail: `${t.toFixed(1)} °C (máx. ${high} °C) · ${readingLabel}`,
          kind: 'temp_high',
          severity: 'critical',
        });
      } else if (low != null && t <= low) {
        out.push({
          id: `${d.id}-low`,
          deviceName: d.name,
          temperatureC: t,
          message: 'Temperatura por debajo del umbral',
          detail: `${t.toFixed(1)} °C (mín. ${low} °C) · ${readingLabel}`,
          kind: 'temp_low',
          severity: 'warning',
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
    return this.chartReadings().some((r) => effectiveCurrentA(r) != null);
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
    return t ? effectiveCurrentA(t) : null;
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
      const hasCurrent = rows.some((r) => effectiveCurrentA(r) != null);

      const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      doc.setFontSize(14);
      doc.text(
        hasCurrent ? 'SG Monitoreo — temperaturas y corriente' : 'SG Monitoreo — temperaturas',
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
          const ia = effectiveCurrentA(r);
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
  scrollToSection(section: 'dashboard' | 'devices' | 'alerts' | 'settings'): void {
    const paths: Record<typeof section, string> = {
      dashboard: '/dashboard',
      devices: '/dispositivos',
      alerts: '/alertas',
      settings: '/configuracion',
    };
    const path = paths[section];
    void this.router.navigate([path], {
      queryParams: this.selectedDeviceId ? { deviceId: this.selectedDeviceId } : { deviceId: null },
      replaceUrl: true,
    });
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
    this.selectedDeviceId = deviceId;
    this.sensorLabelsDirty = false;
    this.notificationSettingsDirty = false;
    this.syncNotificationFormWithSelected();
    this.syncPdfExportDateDefaults();
    if (syncQueryToUrl) {
      const path = this.router.url.split('?')[0];
      const shellPaths = ['/dashboard', '/dispositivos', '/alertas', '/configuracion'];
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
      const needsCol = cloudError.includes('temp1_offset') || cloudError.includes('column');
      this.calibrationFeedback = needsCol
        ? 'Ejecutá en Supabase el SQL: FRONTEND/supabase/sql/007_temp_calibration_offsets.sql'
        : `No se pudo guardar en la nube: ${cloudError}`;
    } else {
      this.calibrationFeedback =
        'Corrección guardada. El valor en la tarjeta se recalcula al instante (bruto + offset) cuando cada lectura tiene temperatura bruta en la nube (SQL 009 + función ingest actualizada).';
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
      this.notificationSettingsSaving = true;
      try {
        const result = await this.deviceStore.updateDeviceNotificationConfig(device.id, {
          alertsEnabled: false,
          tempLowC: null,
          tempHighC: null,
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
    let delayMs: number;
    let offlineDelayMs: number;
    try {
      low = this.parseTempValue(this.tempLowForm);
      high = this.parseTempValue(this.tempHighForm);
      delayMs = this.parseDelayMinutesToMs(this.tempPushDelayMinForm);
      offlineDelayMs = this.parseDelayMinutesToMs(this.offlinePushDelayMinForm);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.notificationSettingsFeedbackIsError = true;
      this.notificationSettingsFeedback = `Revisá los valores (min/máx/retardo): ${msg}`;
      this.scheduleNotificationFeedbackClear();
      return;
    }
    if (low != null && high != null && low > high) {
      this.notificationSettingsFeedbackIsError = true;
      this.notificationSettingsFeedback = 'El umbral mínimo no puede ser mayor al máximo.';
      this.scheduleNotificationFeedbackClear();
      return;
    }

    this.notificationSettingsSaving = true;
    try {
      const result = await this.deviceStore.updateDeviceNotificationConfig(device.id, {
        alertsEnabled: true,
        tempLowC: low,
        tempHighC: high,
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
    const sign = c > 0 ? '+' : '';
    return `${sign}${c.toFixed(1)}°C`;
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
    const ia = effectiveCurrentA({
      deviceId: '',
      at: '',
      temperatureC: h.temperatureC,
      currentA: h.currentA ?? null,
      powerW: h.powerW ?? null,
    });
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
    const ia = effectiveCurrentA(r);
    if (ia != null && Number.isFinite(ia)) {
      s += ` · ${ia.toFixed(2)} A`;
    }
    return s;
  }

  formatCurrent(amps: number | null | undefined): string {
    if (amps == null || Number.isNaN(amps)) return '—';
    return `${amps.toFixed(2)} A`;
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
    const n = series.length;
    const out: (number | null)[] = new Array(n).fill(null);
    let last: number | null = null;
    for (let i = 0; i < n; i++) {
      const t = effectiveCurrentA(series[i]);
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
      this.tempPushDelayMinForm = '15';
      this.offlinePushDelayMinForm = '15';
      this.temp1OffsetForm = '0';
      this.temp2OffsetForm = '0';
      this.temp3OffsetForm = '0';
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
            this.lastAlarmToneAtMs = this.loadPersistedLastAlarmToneAtOrNow();
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
    if (newIds.length > 0) {
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
      if (now - this.lastAlarmToneAtMs >= cooldownMs) {
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
    if (alertId.endsWith('-offline')) return alertId.slice(0, -'-offline'.length);
    if (alertId.endsWith('-crit')) return alertId.slice(0, -'-crit'.length);
    if (alertId.endsWith('-low')) return alertId.slice(0, -'-low'.length);
    return null;
  }

  private persistPanelAlertIdsSnapshot(current: Set<string>): void {
    try {
      localStorage.setItem(this.panelAlertIdsStorageKey, JSON.stringify([...current]));
    } catch {
      /* */
    }
  }

  /** Evita lastAlarmToneAtMs=0: si no hay marca, el retardo parece “cumplido” y suena al abrir la app */
  private loadPersistedLastAlarmToneAtOrNow(): number {
    try {
      const raw = localStorage.getItem(this.panelLastAlarmToneAtStorageKey);
      if (!raw) {
        return Date.now();
      }
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || n > Date.now()) {
        return Date.now();
      }
      return n;
    } catch {
      return Date.now();
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
    if (Notification.permission === 'default') {
      void Notification.requestPermission();
      return;
    }
    if (Notification.permission !== 'granted') return;
    const byId = new Map(this.activeAlerts.map((a) => [a.id, a]));
    for (const alertId of newAlertIds) {
      const al = byId.get(alertId);
      if (!al) continue;
      const did = this.deviceIdFromAlertId(alertId);
      const cooldownMs = this.panelAlarmCooldownMsForDeviceAndKind(did, al.kind);
      try {
        const key = `sg_browser_notif_${alertId}`;
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
      }
      const body = al.detail ? `${al.message}\n${al.detail}` : al.message;
      try {
        new Notification(title, { body, tag: al.id });
      } catch {
        // no-op
      }
    }
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
    if (this.activeAlerts.some((a) => a.kind === 'temp_high')) return 'temp_hot';
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
