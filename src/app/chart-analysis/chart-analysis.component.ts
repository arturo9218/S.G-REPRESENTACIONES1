import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { DeviceStoreService } from '../core/device-store.service';
import { DashboardDevice, TemperatureReading } from '../core/models/dashboard.models';
import { environment } from '../../environments/environment';

type AnalysisChannel = 'temp1' | 'temp2' | 'both';

@Component({
  selector: 'app-chart-analysis',
  templateUrl: './chart-analysis.component.html',
  styleUrls: ['./chart-analysis.component.scss'],
})
export class ChartAnalysisComponent implements OnInit, OnDestroy {
  readonly environment = environment;

  devices: DashboardDevice[] = [];
  readings: TemperatureReading[] = [];

  selectedDeviceId: string | null = null;

  analysisChannel: AnalysisChannel = 'both';

  sensor1LabelForm = '';
  sensor2LabelForm = '';
  sensorLabelsSaving = false;
  sensorLabelsFeedback = '';
  hoverIndex: number | null = null;
  filterDay = '';
  filterFrom = '';
  filterTo = '';
  sidebarCollapsed = false;
  sidebarPeek = false;

  private subDev: Subscription | null = null;
  private subRead: Subscription | null = null;

  readonly chartGridYStops = [14, 34, 54, 74, 86];

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService,
    private readonly deviceStore: DeviceStoreService
  ) {}

  ngOnInit(): void {
    // Asegura que el store use scope autenticado también en pestaña nueva.
    this.deviceStore.refreshScopeFromSession();

    // Soporta ambos nombres por compatibilidad: deviceId (correcto) y deviceld (typo viejo).
    const qp = this.route.snapshot.queryParamMap;
    this.selectedDeviceId = qp.get('deviceId') ?? qp.get('deviceld');

    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.devices = list;
      if (!this.selectedDeviceId || !list.some((d) => d.id === this.selectedDeviceId)) {
        this.selectedDeviceId = this.pickBestDeviceId();
      }
      this.syncSensorLabelsWithSelected();
    });

    this.subRead = this.deviceStore.readings$.subscribe((list) => {
      this.readings = list;
      if (this.selectedDeviceId && this.chartReadings().length === 0) {
        const best = this.pickBestDeviceId();
        if (best) this.selectedDeviceId = best;
      }
    });

    // Al abrir en pestaña nueva, forzamos una lectura de nube para evitar gráfico vacío.
    window.setTimeout(() => {
      this.deviceStore.forceRefreshCloudReadings();
    }, 300);
    window.setTimeout(() => {
      this.deviceStore.refreshScopeFromSession();
      this.deviceStore.forceRefreshCloudReadings();
    }, 1200);
  }

  ngOnDestroy(): void {
    this.subDev?.unsubscribe();
    this.subRead?.unsubscribe();
  }

  get selectedDevice(): DashboardDevice | null {
    if (!this.selectedDeviceId) return null;
    return this.devices.find((d) => d.id === this.selectedDeviceId) ?? null;
  }

  get hasSecondSeries(): boolean {
    return this.chartReadings().some((r) => r.temp2C != null && Number.isFinite(r.temp2C));
  }

  get hasChartData(): boolean {
    return this.chartReadings().length >= 2;
  }

  get debugStatus(): string {
    const selected = this.selectedDeviceId ?? 'none';
    const selectedCount = this.readings.filter((r) => r.deviceId === this.selectedDeviceId).length;
    return `dev:${selected} · lecturas:${selectedCount}/${this.readings.length} · dispositivos:${this.devices.length}`;
  }

  get showSidebar(): boolean {
    return !this.sidebarCollapsed || this.sidebarPeek;
  }

  get showTemp1(): boolean {
    return this.analysisChannel === 'temp1' || this.analysisChannel === 'both';
  }

  get showTemp2(): boolean {
    return this.analysisChannel === 'temp2' || this.analysisChannel === 'both';
  }

  get chartXStartLabel(): string {
    const s = this.chartReadings();
    if (!s.length) return '—';
    return this.formatChartTime(s[0].at);
  }

  get chartXMidLabel(): string {
    const s = this.chartReadings();
    if (!s.length) return '—';
    return this.formatChartTime(s[Math.floor((s.length - 1) / 2)].at);
  }

  get chartXEndLabel(): string {
    const s = this.chartReadings();
    if (!s.length) return '—';
    return this.formatChartTime(s[s.length - 1].at);
  }

  get hoverX(): number | null {
    if (this.hoverIndex == null) return null;
    const n = this.chartReadings().length;
    if (n < 2) return n === 1 ? 50 : null;
    return (this.hoverIndex / (n - 1)) * 100;
  }

  get hoverYTemp1(): number | null {
    if (this.hoverIndex == null || !this.showTemp1) return null;
    const s = this.chartReadings();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return null;
    return this.chartScale().toSvgY(s[idx].temperatureC);
  }

  get hoverYTemp2(): number | null {
    if (this.hoverIndex == null || !this.showTemp2) return null;
    const s = this.chartReadings();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return null;
    const filled = this.temp2SeriesForwardFilled(s);
    const t2 = filled[idx];
    if (t2 == null || Number.isNaN(t2)) return null;
    return this.chartScale().toSvgY(t2);
  }

  get hoverTimeLabel(): string {
    if (this.hoverIndex == null) return '';
    const s = this.chartReadings();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return '';
    return this.formatChartDateTime(s[idx].at);
  }

  get hoverTemp1Label(): string {
    if (this.hoverIndex == null || !this.showTemp1) return '—';
    const s = this.chartReadings();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return '—';
    return `${s[idx].temperatureC.toFixed(1)}°C`;
  }

  get hoverTemp2Label(): string {
    if (this.hoverIndex == null || !this.showTemp2) return '—';
    const s = this.chartReadings();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return '—';
    const filled = this.temp2SeriesForwardFilled(s);
    const t2 = filled[idx];
    if (t2 == null || Number.isNaN(t2)) return '—';
    return `${t2.toFixed(1)}°C`;
  }

  toggleChannel(channel: AnalysisChannel): void {
    this.analysisChannel = channel;
  }

  clearDateFilters(): void {
    this.filterDay = '';
    this.filterFrom = '';
    this.filterTo = '';
  }

  onFilterDayChange(): void {
    // Evita mezclar "Día exacto" con "rango"
    if (this.filterDay) {
      this.filterFrom = '';
      this.filterTo = '';
    }
  }

  onFilterRangeChange(): void {
    // Si el usuario usa rango, desactiva "Día exacto"
    if (this.filterFrom || this.filterTo) {
      this.filterDay = '';
    }
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    if (!this.sidebarCollapsed) this.sidebarPeek = false;
  }

  openSidebarPeek(): void {
    if (this.sidebarCollapsed) this.sidebarPeek = true;
  }

  closeSidebarPeek(): void {
    if (this.sidebarCollapsed) this.sidebarPeek = false;
  }

  async toggleChartFullscreen(panel: HTMLElement): Promise<void> {
    if (!document.fullscreenElement) {
      await panel.requestFullscreen();
      return;
    }
    await document.exitFullscreen();
  }

  onChartMouseMove(event: MouseEvent): void {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const series = this.chartReadings();
    if (!series.length) {
      this.hoverIndex = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rel = (event.clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, rel));
    this.hoverIndex = Math.round(clamped * (series.length - 1));
  }

  onChartMouseLeave(): void {
    this.hoverIndex = null;
  }

  backToDashboard(): void {
    void this.router.navigate(['/dashboard']);
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
    } finally {
      this.sensorLabelsSaving = false;
      window.setTimeout(() => {
        this.sensorLabelsFeedback = '';
      }, 5000);
    }
  }

  syncSensorLabelsWithSelected(): void {
    const d = this.selectedDevice;
    if (!d) {
      this.sensor1LabelForm = '';
      this.sensor2LabelForm = '';
      return;
    }
    this.sensor1LabelForm = d.sensor1Label?.trim() || 'Sensor 1';
    this.sensor2LabelForm = d.sensor2Label?.trim() || 'Sensor 2';
  }

  chartLastPointS1(): { cx: number; cy: number } | null {
    if (!this.showTemp1) return null;
    const series = this.chartReadings();
    const n = series.length;
    if (n < 1) return null;
    const sc = this.chartScale();
    const x = n > 1 ? 100 : 50;
    return { cx: x, cy: sc.toSvgY(series[n - 1].temperatureC) };
  }

  chartLastPointS2(): { cx: number; cy: number } | null {
    if (!this.showTemp2) return null;
    if (!this.hasSecondSeries) return null;
    const series = this.chartReadings();
    const n = series.length;
    if (n < 1) return null;
    const filled = this.temp2SeriesForwardFilled(series);
    const tEnd = filled[n - 1];
    if (tEnd == null || Number.isNaN(tEnd)) return null;
    const sc = this.chartScale();
    return { cx: n > 1 ? 100 : 50, cy: sc.toSvgY(tEnd) };
  }

  get chartCurrentLabel1(): string {
    const p = this.chartLastPointS1();
    if (!p) return '—';
    const series = this.chartReadings();
    const n = series.length;
    if (!n) return '—';
    const v = series[n - 1].temperatureC;
    return `${v.toFixed(1)}°C`;
  }

  get chartCurrentLabel2(): string {
    const p = this.chartLastPointS2();
    if (!p) return '—';
    const series = this.chartReadings();
    const n = series.length;
    if (!n) return '—';
    const filled = this.temp2SeriesForwardFilled(series);
    const v = filled[n - 1];
    if (v == null || Number.isNaN(v)) return '—';
    return `${v.toFixed(1)}°C`;
  }

  private chartValueRange(): { minV: number; maxV: number; span: number } | null {
    const series = this.chartReadings();
    if (!series.length) return null;

    const vals: number[] = [];
    if (this.showTemp1) vals.push(...series.map((r) => r.temperatureC));
    if (this.showTemp2) {
      const filled = this.temp2SeriesForwardFilled(series);
      for (const t of filled) {
        if (t != null && Number.isFinite(t)) vals.push(t);
      }
    }

    if (!vals.length) return null;

    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const span = maxV - minV;
    return { minV, maxV, span };
  }

  private chartPaddedBounds():
    | { minV: number; maxV: number; span: number }
    | null {
    const raw = this.chartValueRange();
    if (!raw) return null;

    let { minV, maxV, span } = raw;
    if (span < 1e-6) {
      span = 0.6;
      return { minV: minV - span / 2, maxV: maxV + span / 2, span };
    }
    const pad = Math.max(0.25, span * 0.06, Math.abs(maxV) * 0.01);
    minV = minV - pad;
    maxV = maxV + pad;
    return { minV, maxV, span: maxV - minV };
  }

  private chartScale(): { toSvgY: (v: number) => number } {
    const padded = this.chartPaddedBounds();
    if (!padded) return { toSvgY: () => 50 };
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

  get chartYMaxLabel(): string {
    const padded = this.chartPaddedBounds();
    if (!padded) return '—';
    return `${padded.maxV.toFixed(1)}°C`;
  }

  get chartYMidLabel(): string {
    const padded = this.chartPaddedBounds();
    if (!padded) return '—';
    return `${((padded.minV + padded.maxV) / 2).toFixed(1)}°C`;
  }

  get chartYMinLabel(): string {
    const padded = this.chartPaddedBounds();
    if (!padded) return '—';
    return `${padded.minV.toFixed(1)}°C`;
  }

  chartPolylinePointsS1(): string {
    if (!this.showTemp1) return '';
    const series = this.chartReadings();
    const n = series.length;
    if (n < 2) return '0,50 100,50';
    const sc = this.chartScale();
    return series
      .map((r, i) => {
        const x = (i / (n - 1)) * 100;
        return `${x},${sc.toSvgY(r.temperatureC)}`;
      })
      .join(' ');
  }

  chartPolylinePointsS2(): string {
    if (!this.showTemp2) return '';
    const series = this.chartReadings();
    const n = series.length;
    if (n < 2) return '';
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScale();
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const t2 = filled[i];
      if (t2 == null || Number.isNaN(t2)) continue;
      const x = (i / (n - 1)) * 100;
      pts.push(`${x},${sc.toSvgY(t2)}`);
    }
    return pts.length >= 2 ? pts.join(' ') : '';
  }

  private chartReadings(): TemperatureReading[] {
    if (!this.selectedDeviceId) return [];
    const source = this.readings.filter((r) => r.deviceId === this.selectedDeviceId);
    let filtered = [...source];

    if (this.filterDay) {
      const dayStart = new Date(`${this.filterDay}T00:00:00`);
      const dayEnd = new Date(`${this.filterDay}T23:59:59.999`);
      const msStart = dayStart.getTime();
      const msEnd = dayEnd.getTime();
      filtered = filtered.filter((r) => {
        const t = new Date(r.at).getTime();
        return Number.isFinite(t) && t >= msStart && t <= msEnd;
      });
    }

    if (this.filterFrom) {
      const fromMs = new Date(this.filterFrom).getTime();
      if (Number.isFinite(fromMs)) {
        filtered = filtered.filter((r) => new Date(r.at).getTime() >= fromMs);
      }
    }

    if (this.filterTo) {
      const parsedTo = new Date(this.filterTo);
      // Si "Hasta" queda en 00:00, tomamos fin de día para que sea inclusivo.
      if (parsedTo.getHours() === 0 && parsedTo.getMinutes() === 0 && parsedTo.getSeconds() === 0) {
        parsedTo.setHours(23, 59, 59, 999);
      }
      const toMs = parsedTo.getTime();
      if (Number.isFinite(toMs)) {
        filtered = filtered.filter((r) => new Date(r.at).getTime() <= toMs);
      }
    }

    const sorted = filtered.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    if (sorted.length) return sorted.slice(-48);

    // Fallback: si aún no hay historial, sintetizar una mini-serie con la temperatura actual
    // para que el gráfico de análisis no quede en blanco.
    const d = this.selectedDevice;
    if (d?.temperatureC != null && !Number.isNaN(d.temperatureC)) {
      const now = Date.now();
      const synthetic: TemperatureReading[] = [];
      for (let i = 11; i >= 0; i--) {
        synthetic.push({
          deviceId: d.id,
          at: new Date(now - i * 60_000).toISOString(),
          temperatureC: d.temperatureC,
          temp2C: d.temperature2C ?? null,
        });
      }
      return synthetic;
    }
    return [];
  }

  private formatChartTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString('es-AR', {
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
      });
    } catch {
      return iso;
    }
  }

  private pickBestDeviceId(): string | null {
    if (!this.devices.length) return null;
    const countById = new Map<string, number>();
    for (const r of this.readings) {
      const prev = countById.get(r.deviceId) ?? 0;
      countById.set(r.deviceId, prev + 1);
    }
    const ordered = [...this.devices].sort((a, b) => {
      const byReadings = (countById.get(b.id) ?? 0) - (countById.get(a.id) ?? 0);
      if (byReadings !== 0) return byReadings;
      const aHasTemp = a.temperatureC != null ? 1 : 0;
      const bHasTemp = b.temperatureC != null ? 1 : 0;
      return bHasTemp - aHasTemp;
    });
    return ordered[0]?.id ?? null;
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

  get sensor1Name(): string {
    const d = this.selectedDevice;
    return d?.sensor1Label?.trim() || 'Sensor 1';
  }

  get sensor2Name(): string {
    const d = this.selectedDevice;
    return d?.sensor2Label?.trim() || 'Sensor 2';
  }

  signOut(): void {
    void this.auth.signOut().then(() => void this.router.navigate(['/login']));
  }
}

