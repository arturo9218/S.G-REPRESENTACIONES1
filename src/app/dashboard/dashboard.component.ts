import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { DeviceStoreService } from '../core/device-store.service';
import {
  ActivityItem,
  DashboardAlert,
  DashboardDevice,
  HistoryListItem,
  TemperatureReading,
} from '../core/models/dashboard.models';
import { environment } from '../../environments/environment';

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
  sensor1LabelForm = '';
  sensor2LabelForm = '';
  sensorLabelsDirty = false;
  sensorLabelsSaving = false;
  sensorLabelsFeedback = '';
  private subDev: Subscription | null = null;
  private subRead: Subscription | null = null;

  /** null = cerrado; 'add' | 'edit' */
  deviceModalMode: 'add' | 'edit' | null = null;
  editingDeviceId: string | null = null;
  addDeviceSubmitting = false;

  /** Vista compacta vs ampliada del gráfico de temperaturas */
  chartExpanded = false;
  alarmEventsCount = 0;
  private lastActiveAlertIds = new Set<string>();
  private readonly alarmsCountStorageKey = 'sg_alarms_count_v1';

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
    private readonly deviceStore: DeviceStoreService
  ) {
    void this.auth.getSession().then((s) => {
      this.email = s?.user.email ?? null;
      const mail = this.email ?? '';
      this.userInitial = mail ? mail.charAt(0).toUpperCase() : '?';
    });
  }

  ngOnInit(): void {
    this.alarmEventsCount = this.loadAlarmEventsCount();
    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.devices = list;
      if (!this.selectedDeviceId && list.length > 0) {
        this.selectDevice(list[0].id);
        return;
      }
      if (this.selectedDeviceId && !list.some((d) => d.id === this.selectedDeviceId)) {
        this.selectDevice(list[0]?.id ?? null);
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
    this.subDev?.unsubscribe();
    this.subRead?.unsubscribe();
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
      const latestAt = latestByDevice.get(d.id);
      const disconnected = latestAt == null || nowMs - latestAt > offlineAfterMs;
      if (disconnected) {
        out.push({
          id: `${d.id}-offline`,
          deviceName: d.name,
          temperatureC: d.temperatureC ?? null,
          message: 'Dispositivo desconectado',
          severity: 'critical',
        });
        continue;
      }

      const t = d.temperatureC;
      if (t == null || !d.alertsEnabled) continue;
      const low = d.tempLowC ?? null;
      const high = d.tempHighC ?? null;
      if (high != null && t >= high) {
        out.push({
          id: `${d.id}-crit`,
          deviceName: d.name,
          temperatureC: t,
          message: 'Dispositivo',
          severity: 'critical',
        });
      } else if (low != null && t <= low) {
        out.push({
          id: `${d.id}-low`,
          deviceName: d.name,
          temperatureC: t,
          message: 'Dispositivo',
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
        tempLabel: this.formatReadingTempsLine(r, l1, l2),
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

  get hasHumidity(): boolean {
    return false;
  }

  /** Reservado cuando haya sensor de humedad real */
  readonly humidityLabel = '—';

  toggleChartExpanded(): void {
    this.chartExpanded = !this.chartExpanded;
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

  selectDevice(deviceId: string | null): void {
    this.selectedDeviceId = deviceId;
    this.sensorLabelsDirty = false;
    this.syncNotificationFormWithSelected();
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

  saveNotificationSettings(): void {
    const device = this.selectedDevice;
    if (!device) return;
    if (!this.alertsEnabledForm) {
      this.deviceStore.updateDeviceNotificationConfig(device.id, {
        alertsEnabled: false,
        tempLowC: null,
        tempHighC: null,
      });
      return;
    }

    const low = this.parseTempValue(this.tempLowForm);
    const high = this.parseTempValue(this.tempHighForm);
    if (low != null && high != null && low > high) {
      alert('El umbral mínimo no puede ser mayor al máximo.');
      return;
    }

    this.deviceStore.updateDeviceNotificationConfig(device.id, {
      alertsEnabled: true,
      tempLowC: low,
      tempHighC: high,
    });
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
      this.deviceStore.updateDeviceMeta(this.editingDeviceId, {
        name: v.name ?? '',
        location: v.location ?? '',
        moduleId: v.moduleId ?? '',
        espLocalIp: v.espLocalIp ?? '',
      });
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
    if (h.temp2C == null || Number.isNaN(h.temp2C)) return `${n1}: ${t1}`;
    return `${n1}: ${t1} · ${n2}: ${this.formatTemp(h.temp2C)}`;
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

  formatPower(w: number | null | undefined): string {
    if (w == null || Number.isNaN(w)) return '—';
    return `${w.toFixed(1)} W`;
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

  /** Punto al final de la serie 1 (lectura más reciente en el gráfico) */
  chartLastPointS1(): { cx: number; cy: number } | null {
    const series = this.chartReadings();
    const n = series.length;
    if (n < 1) return null;
    const sc = this.chartScale();
    const i = n - 1;
    const x = n > 1 ? (i / (n - 1)) * 100 : 50;
    return { cx: x, cy: sc.toSvgY(series[i].temperatureC) };
  }

  /** Marca al final de la serie 2 (misma lógica de relleno que la polyline). */
  chartLastPointS2(): { cx: number; cy: number } | null {
    const series = this.chartReadings();
    const n = series.length;
    if (n < 1 || !this.chartHasSecondSeries()) return null;
    const filled = this.temp2SeriesForwardFilled(series);
    const tEnd = filled[n - 1];
    if (tEnd == null || Number.isNaN(tEnd)) return null;
    const sc = this.chartScale();
    const x = n > 1 ? 100 : 50;
    return { cx: x, cy: sc.toSvgY(tEnd) };
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
    const series = this.chartReadings();
    const w = 100;
    const h = 100;
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

  /**
   * Segunda serie (temp2), mismo eje Y. Rellena huecos con el último valor
   * conocido para que la línea no “escalone” cuando el backend no manda temp2 en cada fila.
   */
  chartPolylinePoints2(): string {
    const series = this.chartReadings();
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
      this.sensor1LabelForm = '';
      this.sensor2LabelForm = '';
      this.sensorLabelsDirty = false;
      return;
    }
    this.alertsEnabledForm = device.alertsEnabled !== false;
    this.tempLowForm =
      device.tempLowC == null || Number.isNaN(device.tempLowC) ? '' : String(device.tempLowC);
    this.tempHighForm =
      device.tempHighC == null || Number.isNaN(device.tempHighC) ? '' : String(device.tempHighC);
    // Mientras el usuario escribe, no pisar el input con refrescos de polling.
    if (!this.sensorLabelsDirty) {
      this.sensor1LabelForm = device.sensor1Label?.trim() || 'Sensor 1';
      this.sensor2LabelForm = device.sensor2Label?.trim() || 'Sensor 2';
    }
  }

  private parseTempValue(value: string): number | null {
    const clean = value.trim().replace(',', '.');
    if (!clean) return null;
    const n = Number.parseFloat(clean);
    return Number.isNaN(n) ? null : n;
  }

  private updateAlarmAccumulator(): void {
    const current = new Set(this.activeAlerts.map((a) => a.id));
    let newEvents = 0;
    for (const id of current) {
      if (!this.lastActiveAlertIds.has(id)) newEvents += 1;
    }
    if (newEvents > 0) {
      this.alarmEventsCount += newEvents;
      this.persistAlarmEventsCount();
      this.tryBrowserNotification(newEvents);
    }
    this.lastActiveAlertIds = current;
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

  private tryBrowserNotification(newEvents: number): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      void Notification.requestPermission();
      return;
    }
    if (Notification.permission !== 'granted') return;
    const title = newEvents === 1 ? 'Nueva alarma de temperatura' : `${newEvents} nuevas alarmas`;
    const body = `Total acumuladas: ${this.alarmEventsCount}`;
    try {
      new Notification(title, { body });
    } catch {
      // no-op
    }
  }
}
