import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import {
  exitFullscreenBestEffort,
  isCurrentFullscreen,
  requestFullscreenBestEffort,
} from '../core/chart-fullscreen';
import {
  chartStyleLabel,
  chartZoomHostIn,
  chartZoomHostIsActive,
  chartZoomHostOut,
  chartZoomHostPanFromDrag,
  chartZoomHostPinch,
  chartZoomHostReset,
  chartZoomHostSlice,
  chartZoomHostWheel,
} from '../core/chart-history-interaction';
import {
  buildChartTimeAxis,
  chartAxisMaxTimeLabels,
  type ChartTimeLabel,
} from '../core/chart-axis.utils';
import {
  CHART_SVG_PRESERVE_ASPECT,
  CHART_PR500_PLOT,
  CHART_TEMP_VIEWBOX_HEIGHT,
  chartPlotNormFromClientX,
  chartViewBoxXFromClientX,
} from '../core/chart-svg-coords';
import {
  chartPagePanelsDefaults,
  loadChartPagePanels,
  persistChartPagePanels,
} from '../core/chart-page-layout';
import {
  downloadDeviceChartPdf,
  pdfCellDate,
  pdfCellNum,
  pdfCellOn,
} from '../core/device-chart-pdf';
import { environment } from '../../environments/environment';
import { isSupabaseConfigured } from '../core/supabase-config';
import { mergePr500Params, PR500_PSI_PER_BAR, pr500BarToPsi } from '../pr500/pr500-params.defaults';
import { PR500_READINGS_POSTGREST_COLUMNS } from '../pr500/pr500-readings.select';
import type { ChartStylePreset } from '../core/models/dashboard.models';

export interface Pr500ReadingRow {
  id: number;
  pr500_id: string;
  created_at: string;
  pressure_bar: number;
  comp1_on: boolean;
  comp2_on: boolean;
  comp3_on: boolean;
  alarm_on: boolean;
  di1_ok: boolean | null;
  di2_ok: boolean | null;
  di3_ok: boolean | null;
  di4_ok: boolean | null;
  /** Ms ON acumulados (telemetría Stage3); opcional hasta migración 038. */
  comp1_run_ms?: number | null;
  comp2_run_ms?: number | null;
  comp3_run_ms?: number | null;
  /** Sonda succión / superheat (migración 039 + firmware Stage3). */
  temp_suction_c?: number | null;
  superheat_c?: number | null;
  superheat_ok?: boolean | null;
}

/** Estadísticas de marcha ON reconstruidas entre lecturas (misma convención que el escalón / barras). */
export interface Pr500MotorLaneStats {
  label: 'C1' | 'C2' | 'C3';
  /** Suma de (t[i+1]−t[i]) cuando en la muestra i el compresor está ON. */
  onMs: number;
  /** Cantidad de flancos OFF→ON entre lecturas consecutivas. */
  starts: number;
  /** Cantidad de flancos ON→OFF entre lecturas consecutivas. */
  stops: number;
  /** Media de `pressure_bar` en la primera lectura donde ya figura ON (tras OFF→ON). */
  avgStartPressureBar: number | null;
  /** Media de `pressure_bar` en la primera lectura donde ya figura OFF (tras ON→OFF). */
  avgStopPressureBar: number | null;
  lastStartIso: string | null;
  lastStartPressureBar: number | null;
  lastStopIso: string | null;
  lastStopPressureBar: number | null;
}

const MAX_FETCH = 8000;
const MAX_DRAW_POINTS = 1600;

@Component({
  selector: 'app-pr500-chart',
  templateUrl: './pr500-chart.component.html',
  styleUrls: ['./pr500-chart.component.scss'],
})
export class Pr500ChartComponent implements OnInit, OnDestroy {
  readonly environment = environment;

  pr500Id: string | null = null;
  pr500Name = 'PR500';
  loading = false;
  error = '';

  filterFrom = '';
  filterTo = '';

  readings: Pr500ReadingRow[] = [];
  displayPoints: Pr500ReadingRow[] = [];
  zoomedPoints: Pr500ReadingRow[] = [];
  /** Tiempo ON + arranques en todo el rango cargado (todas las filas, hasta el límite de consulta). */
  motorStatsRange: Pr500MotorLaneStats[] = [];
  /** Con zoom: mismas métricas filtrando lecturas entre el primer y último instante de la vista. Sin zoom, copia de `motorStatsRange`. */
  motorStatsVisible: Pr500MotorLaneStats[] = [];
  /** Mediana del intervalo entre muestras en `readings` (ayuda a interpretar la granularidad). */
  motorSampleMedianMs: number | null = null;

  pressurePath = '';
  /** Polígono bajo la curva (relleno suave en el SVG). */
  pressureAreaPath = '';
  /** Estilo «Análisis de gráfico» (localStorage independiente del dashboard). */
  private readonly chartStyleStorageKey = 'ar_pr500_chart_style_v1';
  chartStylePreset: ChartStylePreset = 'area';
  readonly chartStyleOptions: { value: ChartStylePreset; label: string }[] = [
    { value: 'area', label: 'Área (relleno suave)' },
    { value: 'line', label: 'Solo líneas' },
    { value: 'minimal', label: 'Minimal (limpio)' },
    { value: 'technical', label: 'Técnico (rejilla)' },
    { value: 'trend', label: 'Tendencia (color por subida/bajada)' },
  ];
  /** Modo tendencia: tramos rojo/azul/gris por subida o bajada de presión. */
  pressureTrendSegs: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> = [];
  /** Puntos sobre la curva: color por compresor(es) ON (capa HTML, estilo tendencia). */
  pressureMotorDots: Array<{ xPct: number; yPct: number; background: string; title: string }> = [];
  cursorMotorBackground = '';
  cursorMotorTitle = '';
  readonly chartTrendGridXs = [20, 35, 50, 65, 80];
  /** Serie °C (eje derecho); tramos separados si hay huecos en los datos. */
  tempPath = '';
  superheatPath = '';
  pMin = 0;
  pMax = 6;
  /** Rango del eje derecho (succión / superheat). */
  tMin = 0;
  tMax = 40;
  hasTempAxis = false;
  tempAxisTicks: { y: number; label: string; markX0: number; markX1: number }[] = [];
  /** Escala Y según `params.F15` del controlador (telemetría siempre en bar). */
  pressureDisplayPsi = false;
  pressureYUnit: 'bar' | 'psi' = 'bar';
  /** Área útil del SVG (viewBox 0–100 × 58). `x1` se estrecha si hay eje de temperatura. */
  plot = { ...CHART_PR500_PLOT };
  readonly chartViewBoxHeight = CHART_TEMP_VIEWBOX_HEIGHT;
  /** Marcas del eje X: posición, texto y segmento de marca bajo el gráfico. */
  timeLabels: ChartTimeLabel[] = [];
  yAxisTicks: { y: number; label: string; markX0: number; markX1: number }[] = [];
  yGridLines: string[] = [];
  /** Rejilla vertical en marcas de tiempo (trazos suaves). */
  xGridLines: string[] = [];
  activityRects: { lane: number; x0: number; x1: number; on: boolean }[] = [];
  /** Trazos escalón ON/OFF (misma escala X que presión); vacíos si no aplica. */
  comp1StepPath = '';
  comp2StepPath = '';
  comp3StepPath = '';
  alarmStepPath = '';
  /** Vista escalón vs barras por tramo. */
  showMotorStepChart = true;
  readonly activityLabels = ['C1', 'C2', 'C3', 'Alarma'];
  /** Gráficos de presión + motores más altos (localStorage). */
  private readonly chartTallStorageKey = 'ar_pr500_chart_tall_v1';
  chartTallLayout = false;

  private readonly layoutStorageKey = 'ar_pr500_chart_panels_v1';
  sidePanelOpen = chartPagePanelsDefaults().sideOpen;
  extrasPanelOpen = false;

  showPressure = true;
  /** Curvas desde `temp_suction_c` / `superheat_c` si existen en el rango. */
  showTempSuction = true;
  showSuperheat = true;
  showComp1 = true;
  showComp2 = true;
  showComp3 = true;
  showAlarm = true;

  cursorActive = false;
  cursorX = 0;
  cursorY = 0;
  cursorTimeLabel = '';
  cursorPressureLabel = '';
  /** Línea extra en el tooltip (succión / SH). */
  cursorTempLabel = '';
  private zoomStartMs = 0;
  private zoomSpanMs = 1;
  private draggingPan = false;
  private dragStartClientX = 0;
  private dragStartLo = 0;
  private dragStartHi = 1;
  private touchMode: 'none' | 'pan' | 'pinch' = 'none';
  private touchStartDist = 0;
  private touchStartSpan = 1;
  private touchStartCenterNorm = 0.5;
  private touchStartZoomLo = 0;
  private touchStartZoomHi = 1;
  /** Móvil: toque corto sin pan/pellizco → fijar cursor (valor en ese instante). */
  private touchSessionMultiFinger = false;
  private touchTapStartX = 0;
  private touchTapStartY = 0;
  private touchTapMoved = false;
  /** Hubo desplazamiento real en modo pan (zoom activo). */
  private touchPanDidNudge = false;

  /** Contenedor del SVG para API de pantalla completa. */
  @ViewChild('chartStage') private chartStage?: ElementRef<HTMLElement>;
  @ViewChild('chartPdfCapture') chartPdfCapture?: ElementRef<HTMLElement>;
  chartFullscreen = false;
  pdfExporting = false;
  /** Zoom horizontal fraccional sobre el rango cargado (0..1). */
  chartZoomLo = 0;
  chartZoomHi = 1;

  private sub?: Subscription;
  private axisLabelBucket = chartAxisMaxTimeLabels();

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService
  ) {}

  ngOnInit(): void {
    this.loadChartStylePreset();
    this.loadChartTallLayout();
    this.loadChartPanels();
    this.sub = this.route.queryParamMap.subscribe((q) => {
      const id = q.get('pr500Id');
      this.pr500Id = id && id.length > 10 ? id : null;
      this.initDefaultRange();
      if (this.pr500Id) {
        void this.loadAll();
      } else {
        this.error = 'Falta pr500Id en la URL (ej. ?pr500Id=…).';
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  @HostListener('document:mouseup')
  onDocMouseUp(): void {
    this.draggingPan = false;
  }

  @HostListener('document:mousemove', ['$event'])
  onDocMouseMove(ev: MouseEvent): void {
    if (!this.draggingPan) return;
    const el = this.chartStage?.nativeElement;
    if (!el) return;
    const w = Math.max(1, el.getBoundingClientRect().width);
    const dxNorm = (ev.clientX - this.dragStartClientX) / w;
    chartZoomHostPanFromDrag(this, dxNorm, this.dragStartLo, this.dragStartHi);
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onChartFullscreenChange(): void {
    const el = this.chartStage?.nativeElement;
    this.chartFullscreen = isCurrentFullscreen(el ?? null);
  }

  @HostListener('window:resize')
  @HostListener('window:orientationchange')
  onChartViewportChange(): void {
    const bucket = chartAxisMaxTimeLabels();
    if (bucket !== this.axisLabelBucket && this.readings.length) {
      this.axisLabelBucket = bucket;
      this.rebuildChartGeometry();
    }
  }

  toggleChartFullscreen(): void {
    const el = this.chartStage?.nativeElement;
    if (!el) return;
    if (isCurrentFullscreen(el)) {
      void exitFullscreenBestEffort();
    } else {
      void requestFullscreenBestEffort(el);
    }
  }

  chartSvgPreserveAspect(): string {
    return CHART_SVG_PRESERVE_ASPECT;
  }

  toggleSidePanel(): void {
    this.sidePanelOpen = !this.sidePanelOpen;
    this.persistChartPanels();
  }

  closeSidePanel(): void {
    if (!this.sidePanelOpen) return;
    this.sidePanelOpen = false;
    this.persistChartPanels();
  }

  toggleExtrasPanel(): void {
    this.extrasPanelOpen = !this.extrasPanelOpen;
    this.persistChartPanels();
  }

  private loadChartPanels(): void {
    const p = loadChartPagePanels(this.layoutStorageKey);
    this.sidePanelOpen = p.sideOpen;
    this.extrasPanelOpen = p.extrasOpen;
  }

  private persistChartPanels(): void {
    persistChartPagePanels(this.layoutStorageKey, {
      sideOpen: this.sidePanelOpen,
      extrasOpen: this.extrasPanelOpen,
    });
  }

  backToApp(): void {
    void this.router.navigate(['/dispositivos']);
  }

  private initDefaultRange(): void {
    const to = new Date();
    const from = new Date(to.getTime() - 48 * 3600 * 1000);
    this.filterTo = this.toLocalInput(to);
    this.filterFrom = this.toLocalInput(from);
  }

  /** Atajos de rango (recarga datos). */
  applyPresetRange(hours: 24 | 48 | 168): void {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    this.filterTo = this.toLocalInput(to);
    this.filterFrom = this.toLocalInput(from);
    this.resetChartZoom();
    void this.loadAll();
  }

  /** Toggles de capas: redibujar sin nuevo fetch. */
  onLayerToggle(): void {
    this.rebuildChartGeometry();
  }

  loadChartStylePreset(): void {
    try {
      const v = localStorage.getItem(this.chartStyleStorageKey);
      if (v === 'area' || v === 'line' || v === 'minimal' || v === 'technical' || v === 'trend') {
        this.chartStylePreset = v;
        return;
      }
    } catch {
      /* ignore */
    }
    this.chartStylePreset = 'area';
  }

  onChartStyleChange(): void {
    try {
      localStorage.setItem(this.chartStyleStorageKey, this.chartStylePreset);
    } catch {
      /* ignore */
    }
    this.rebuildChartGeometry();
  }

  loadChartTallLayout(): void {
    try {
      this.chartTallLayout = localStorage.getItem(this.chartTallStorageKey) === '1';
    } catch {
      this.chartTallLayout = false;
    }
  }

  toggleChartTallLayout(): void {
    this.chartTallLayout = !this.chartTallLayout;
    try {
      localStorage.setItem(this.chartTallStorageKey, this.chartTallLayout ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  onMotorViewToggle(): void {
    this.rebuildChartGeometry();
  }

  /** Escalón “mantiene valor hasta la siguiente muestra” (misma convención que muchos SCADA). */
  private static buildBooleanStepPath(
    pts: Pr500ReadingRow[],
    xAt: (iso: string) => number,
    isOn: (p: Pr500ReadingRow) => boolean,
    yOn: number,
    yOff: number
  ): string {
    if (pts.length === 0) return '';
    const yv = (i: number) => (isOn(pts[i]) ? yOn : yOff);
    const x0 = xAt(pts[0].created_at);
    const parts: string[] = [`M${x0.toFixed(2)},${yv(0).toFixed(2)}`];
    for (let i = 0; i < pts.length - 1; i++) {
      const xa = xAt(pts[i + 1].created_at);
      const yi = yv(i);
      const yj = yv(i + 1);
      parts.push(`L${xa.toFixed(2)},${yi.toFixed(2)}`);
      if (yj !== yi) {
        parts.push(`L${xa.toFixed(2)},${yj.toFixed(2)}`);
      }
    }
    return parts.join(' ');
  }

  chartShowsAreaFill(): boolean {
    return this.showPressure && (this.chartStylePreset === 'area' || this.chartStylePreset === 'technical');
  }

  chartPressureUsesGlow(): boolean {
    return this.chartStylePreset === 'area' || this.chartStylePreset === 'technical';
  }

  private noteTouchTapStart(ev: TouchEvent): void {
    if (ev.touches.length >= 2) {
      this.touchSessionMultiFinger = true;
      return;
    }
    if (ev.touches.length === 1) {
      const t = ev.touches[0];
      this.touchTapStartX = t.clientX;
      this.touchTapStartY = t.clientY;
      this.touchTapMoved = false;
      this.touchPanDidNudge = false;
    }
  }

  private noteTouchTapMove(ev: TouchEvent): void {
    if (this.touchSessionMultiFinger || ev.touches.length !== 1) return;
    const t = ev.touches[0];
    if (Math.hypot(t.clientX - this.touchTapStartX, t.clientY - this.touchTapStartY) > 16) {
      this.touchTapMoved = true;
    }
  }

  /** Misma lógica que mousemove: posición en viewBox 0–100 y cursor activo. */
  applyCursorFromClientX(clientX: number): void {
    const stage = this.chartStage?.nativeElement;
    if (!stage || !this.zoomedPoints.length) return;
    const x = chartViewBoxXFromClientX(clientX, stage);
    if (x == null) return;
    this.cursorActive = true;
    this.updateCursorForX(x);
  }

  private toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}`;
  }

  private parseLocalInput(s: string): Date | null {
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  async loadAll(): Promise<void> {
    if (!this.pr500Id || !environment.deviceCloudSync || !isSupabaseConfigured()) {
      this.error = 'Nube no configurada o sesión no disponible.';
      return;
    }
    this.loading = true;
    this.error = '';
    try {
      const session = await this.auth.getSession();
      if (!session?.user) {
        void this.router.navigate(['/login']);
        return;
      }
      const { data: meta, error: eMeta } = await this.auth.client
        .from('pr500_controllers')
        .select('name, params')
        .eq('id', this.pr500Id)
        .maybeSingle();
      if (eMeta) {
        this.error = eMeta.message;
        return;
      }
      const metaRow = meta as { name?: string; params?: unknown } | null;
      this.pr500Name = metaRow?.name?.trim() || 'PR500';
      const m = mergePr500Params(metaRow?.params ?? null);
      this.pressureDisplayPsi = m.F15 >= 0.5;
      this.pressureYUnit = this.pressureDisplayPsi ? 'psi' : 'bar';

      const fromD = this.parseLocalInput(this.filterFrom);
      const toD = this.parseLocalInput(this.filterTo);
      if (!fromD || !toD || fromD >= toD) {
        this.error = 'Revisá el rango de fechas (desde < hasta).';
        return;
      }
      const fromIso = fromD.toISOString();
      const toIso = toD.toISOString();

      const { data: rows, error: eRows } = await this.auth.client
        .from('pr500_readings')
        .select(PR500_READINGS_POSTGREST_COLUMNS)
        .eq('pr500_id', this.pr500Id)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: true })
        .limit(MAX_FETCH);

      if (eRows) {
        if (eRows.message?.includes('Could not find') || eRows.code === '42P01') {
          this.error =
            'Falta la tabla de historial. Ejecutá en Supabase `037_pr500_readings.sql` y redeployá `ingest-reading`.';
        } else {
          this.error = eRows.message;
        }
        this.readings = [];
        this.displayPoints = [];
        this.motorStatsRange = Pr500ChartComponent.emptyMotorStats();
        this.motorStatsVisible = Pr500ChartComponent.emptyMotorStats();
        this.motorSampleMedianMs = null;
        return;
      }
      this.readings = (rows ?? []) as Pr500ReadingRow[];
      this.downsample();
      if (this.chartZoomHi <= this.chartZoomLo || this.displayPoints.length < 3) {
        this.chartZoomLo = 0;
        this.chartZoomHi = 1;
      }
      this.rebuildChartGeometry();
    } finally {
      this.loading = false;
    }
  }

  private downsample(): void {
    const src = this.readings;
    if (src.length <= MAX_DRAW_POINTS) {
      this.displayPoints = src.slice();
      return;
    }
    const step = Math.ceil(src.length / MAX_DRAW_POINTS);
    const out: Pr500ReadingRow[] = [];
    for (let i = 0; i < src.length; i += step) {
      out.push(src[i]);
    }
    if (out.length === 0 || out[out.length - 1].id !== src[src.length - 1].id) {
      out.push(src[src.length - 1]);
    }
    this.displayPoints = out;
  }

  applyFilters(): void {
    this.resetChartZoom();
    void this.loadAll();
  }

  get chartZoomIsActive(): boolean {
    return chartZoomHostIsActive(this);
  }

  chartZoomIn(): void {
    chartZoomHostIn(this);
  }

  chartZoomOut(): void {
    chartZoomHostOut(this);
  }

  resetChartZoom(): void {
    chartZoomHostReset(this);
    this.cursorActive = false;
  }

  onChartWheel(ev: WheelEvent): void {
    chartZoomHostWheel(
      this,
      ev,
      this.chartStage?.nativeElement,
      this.zoomedPoints.length > 0,
      this.plot.x0,
      this.plot.x1
    );
  }

  async downloadChartPdf(): Promise<void> {
    if (this.pdfExporting || !this.readings.length) return;
    this.pdfExporting = true;
    this.cursorActive = false;
    try {
      await downloadDeviceChartPdf({
        title: 'Historial PR500',
        deviceName: this.pr500Name,
        rangeLabel: this.pdfRangeLabel(),
        styleLabel: chartStyleLabel(this.chartStyleOptions, this.chartStylePreset),
        rows: this.readings as unknown as Record<string, unknown>[],
        columns: [
          { header: 'Fecha', cell: (r) => pdfCellDate(r['created_at']) },
          { header: 'Presión bar', cell: (r) => pdfCellNum(r['pressure_bar'], 2) },
          { header: 'C1', cell: (r) => pdfCellOn(r['comp1_on']) },
          { header: 'C2', cell: (r) => pdfCellOn(r['comp2_on']) },
          { header: 'C3', cell: (r) => pdfCellOn(r['comp3_on']) },
          { header: 'Alarma', cell: (r) => pdfCellOn(r['alarm_on']) },
          { header: 'Succión °C', cell: (r) => pdfCellNum(r['temp_suction_c'], 1) },
        ],
        fileSlug: this.pr500Name || 'pr500',
        captureEl: this.chartPdfCapture?.nativeElement,
      });
    } finally {
      this.pdfExporting = false;
    }
  }

  private pdfRangeLabel(): string {
    return `${this.filterFrom || '—'} → ${this.filterTo || '—'}`;
  }

  /** Última lectura del rango cargado (para cabecera del gráfico). */
  get latestReading(): Pr500ReadingRow | null {
    return this.readings.length ? this.readings[this.readings.length - 1] : null;
  }

  private static emptyMotorStats(): Pr500MotorLaneStats[] {
    const base = (label: 'C1' | 'C2' | 'C3'): Pr500MotorLaneStats => ({
      label,
      onMs: 0,
      starts: 0,
      stops: 0,
      avgStartPressureBar: null,
      avgStopPressureBar: null,
      lastStartIso: null,
      lastStartPressureBar: null,
      lastStopIso: null,
      lastStopPressureBar: null,
    });
    return [base('C1'), base('C2'), base('C3')];
  }

  /** Misma convención que `buildActivityRects`; presión de transición = `pressure_bar` de la primera muestra con el nuevo estado. */
  private static computeMotorStats(rows: Pr500ReadingRow[]): Pr500MotorLaneStats[] {
    if (rows.length < 2) return Pr500ChartComponent.emptyMotorStats();

    type Acc = {
      label: 'C1' | 'C2' | 'C3';
      onMs: number;
      starts: number;
      stops: number;
      sumStart: number;
      nStart: number;
      sumStop: number;
      nStop: number;
      lastStartIso: string | null;
      lastStartBar: number | null;
      lastStopIso: string | null;
      lastStopBar: number | null;
    };
    const accs: Acc[] = [
      { label: 'C1', onMs: 0, starts: 0, stops: 0, sumStart: 0, nStart: 0, sumStop: 0, nStop: 0, lastStartIso: null, lastStartBar: null, lastStopIso: null, lastStopBar: null },
      { label: 'C2', onMs: 0, starts: 0, stops: 0, sumStart: 0, nStart: 0, sumStop: 0, nStop: 0, lastStartIso: null, lastStartBar: null, lastStopIso: null, lastStopBar: null },
      { label: 'C3', onMs: 0, starts: 0, stops: 0, sumStart: 0, nStart: 0, sumStop: 0, nStop: 0, lastStartIso: null, lastStartBar: null, lastStopIso: null, lastStopBar: null },
    ];
    const getOn = (r: Pr500ReadingRow, k: number): boolean =>
      k === 0 ? !!r.comp1_on : k === 1 ? !!r.comp2_on : !!r.comp3_on;

    for (let i = 0; i < rows.length - 1; i++) {
      const tA = new Date(rows[i].created_at).getTime();
      const tB = new Date(rows[i + 1].created_at).getTime();
      const dt = tB - tA;
      if ((dt > 0) && Number.isFinite(dt)) {
        for (let k = 0; k < 3; k++) {
          if (getOn(rows[i], k)) accs[k].onMs += dt;
        }
      }
      const next = rows[i + 1];
      const p = next.pressure_bar;
      const pOk = Number.isFinite(p);
      for (let k = 0; k < 3; k++) {
        const a = getOn(rows[i], k);
        const b = getOn(next, k);
        if (!a && b) {
          accs[k].starts++;
          if (pOk) {
            accs[k].sumStart += p;
            accs[k].nStart++;
          }
          accs[k].lastStartIso = next.created_at;
          accs[k].lastStartBar = pOk ? p : null;
        }
        if (a && !b) {
          accs[k].stops++;
          if (pOk) {
            accs[k].sumStop += p;
            accs[k].nStop++;
          }
          accs[k].lastStopIso = next.created_at;
          accs[k].lastStopBar = pOk ? p : null;
        }
      }
    }

    return accs.map((a) => ({
      label: a.label,
      onMs: a.onMs,
      starts: a.starts,
      stops: a.stops,
      avgStartPressureBar: a.nStart > 0 ? a.sumStart / a.nStart : null,
      avgStopPressureBar: a.nStop > 0 ? a.sumStop / a.nStop : null,
      lastStartIso: a.lastStartIso,
      lastStartPressureBar: a.lastStartBar,
      lastStopIso: a.lastStopIso,
      lastStopPressureBar: a.lastStopBar,
    }));
  }

  private computeMedianSampleGapMs(rows: Pr500ReadingRow[]): number | null {
    if (rows.length < 3) return null;
    const gaps: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const d = new Date(rows[i].created_at).getTime() - new Date(rows[i - 1].created_at).getTime();
      if (d > 0 && d < 86400000) gaps.push(d);
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  private updateMotorTimeSummaries(zoomedDisplayPts: Pr500ReadingRow[]): void {
    this.motorSampleMedianMs = this.computeMedianSampleGapMs(this.readings);
    this.motorStatsRange = Pr500ChartComponent.computeMotorStats(this.readings);
    if (!this.chartZoomIsActive || zoomedDisplayPts.length < 1) {
      this.motorStatsVisible = this.motorStatsRange.map((s) => ({ ...s }));
      return;
    }
    const tWin0 = new Date(zoomedDisplayPts[0].created_at).getTime();
    const tWin1 = new Date(zoomedDisplayPts[zoomedDisplayPts.length - 1].created_at).getTime();
    const win = this.readings.filter((r) => {
      const tx = new Date(r.created_at).getTime();
      return tx >= tWin0 && tx <= tWin1;
    });
    this.motorStatsVisible =
      win.length >= 2
        ? Pr500ChartComponent.computeMotorStats(win)
        : Pr500ChartComponent.computeMotorStats(zoomedDisplayPts);
  }

  /** Texto legible para duraciones (resumen de motores y muestreo). */
  formatMotorDuration(ms: number): string {
    if (!(ms > 0) || !Number.isFinite(ms)) return '0 s';
    const sec = Math.round(ms / 1000);
    if (sec < 120) return `${sec} s`;
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h >= 48) {
      const d = Math.floor(h / 24);
      const hr = h % 24;
      if (d > 0) return m > 0 ? `${d} d ${hr} h ${m} min` : `${d} d ${hr} h`;
      return `${h} h ${m} min`;
    }
    if (h > 0) return `${h} h ${m} min`;
    return `${m} min`;
  }

  motorStartsLabel(n: number): string {
    if (n === 1) return '1 arranque detectado';
    return `${n} arranques detectados`;
  }

  motorStopsLabel(n: number): string {
    if (n === 1) return '1 parada detectada';
    return `${n} paradas detectadas`;
  }

  /** `pressure_bar` de la telemetría en la unidad del eje (bar o psi según F15). */
  formatPressureBarReading(bar: number | null | undefined): string {
    if (bar == null || !Number.isFinite(bar)) return '—';
    const v = this.pressureDisplayPsi ? pr500BarToPsi(bar) : bar;
    return `${this.formatYAxisValue(v)} ${this.pressureYUnit}`;
  }

  formatMotorEventLocal(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  formatYAxisValue(v: number): string {
    if (this.pressureDisplayPsi) return v.toFixed(1);
    return v.toFixed(2);
  }

  /** C1 azul · C2 rojo · C3 verde (puntos de presión y escalón de motores). */
  private static readonly MOTOR_COLORS = {
    c1: '#3b82f6',
    c2: '#ef4444',
    c3: '#22c55e',
    none: '#64748b',
  } as const;

  private static readonly MOTOR_DOT_MAX = 360;

  static motorConicGradient(c1: boolean, c2: boolean, c3: boolean): string {
    const colors: string[] = [];
    if (c1) colors.push(Pr500ChartComponent.MOTOR_COLORS.c1);
    if (c2) colors.push(Pr500ChartComponent.MOTOR_COLORS.c2);
    if (c3) colors.push(Pr500ChartComponent.MOTOR_COLORS.c3);
    if (colors.length === 0) return Pr500ChartComponent.MOTOR_COLORS.none;
    if (colors.length === 1) return colors[0];
    const step = 360 / colors.length;
    const stops: string[] = [];
    for (let i = 0; i < colors.length; i++) {
      const a0 = i * step;
      const a1 = (i + 1) * step;
      stops.push(`${colors[i]} ${a0}deg ${a1}deg`);
    }
    return `conic-gradient(from -90deg, ${stops.join(', ')})`;
  }

  static motorDotTitle(c1: boolean, c2: boolean, c3: boolean): string {
    const on: string[] = [];
    if (c1) on.push('C1');
    if (c2) on.push('C2');
    if (c3) on.push('C3');
    return on.length ? `${on.join(' + ')} ON` : 'Sin compresor ON';
  }

  private motorStatesFromRow(p: Pr500ReadingRow): { c1: boolean; c2: boolean; c3: boolean } {
    return {
      c1: this.showComp1 && !!p.comp1_on,
      c2: this.showComp2 && !!p.comp2_on,
      c3: this.showComp3 && !!p.comp3_on,
    };
  }

  private rebuildPressureMotorDots(
    pts: Pr500ReadingRow[],
    xAt: (iso: string) => number,
    yAtVal: (val: number) => number
  ): void {
    this.pressureMotorDots = [];
    if (this.chartStylePreset !== 'trend' || !this.showPressure || pts.length === 0) return;
    const dotStep =
      pts.length > Pr500ChartComponent.MOTOR_DOT_MAX
        ? Math.ceil(pts.length / Pr500ChartComponent.MOTOR_DOT_MAX)
        : 1;
    const pushAt = (i: number) => {
      const yv = this.pressureDisplayPsi ? pts[i].pressure_bar * PR500_PSI_PER_BAR : pts[i].pressure_bar;
      if (!Number.isFinite(yv)) return;
      const y = yAtVal(yv);
      if (!Number.isFinite(y)) return;
      const m = this.motorStatesFromRow(pts[i]);
      this.pressureMotorDots.push({
        xPct: xAt(pts[i].created_at),
        yPct: y,
        background: Pr500ChartComponent.motorConicGradient(m.c1, m.c2, m.c3),
        title: Pr500ChartComponent.motorDotTitle(m.c1, m.c2, m.c3),
      });
    };
    for (let i = 0; i < pts.length; i += dotStep) pushAt(i);
    const lastIdx = pts.length - 1;
    if (lastIdx >= 0 && lastIdx % dotStep !== 0) pushAt(lastIdx);
  }

  private static niceStep(range: number, targetTicks: number): number {
    const rough = range / Math.max(targetTicks - 1, 1);
    const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-9))));
    const err = rough / pow10;
    let n = 10;
    if (err <= 1) n = 1;
    else if (err <= 2) n = 2;
    else if (err <= 5) n = 5;
    return n * pow10;
  }

  private static readonly MS = 1000;
  private static readonly DAY = 24 * 3600 * Pr500ChartComponent.MS;
  /** Pasos de tiempo “redondos”; el primero ≥ span/maxTicks define la escala del eje X. */
  private static readonly TIME_STEP_CANDIDATES_MS = [
    10 * Pr500ChartComponent.MS,
    15 * Pr500ChartComponent.MS,
    30 * Pr500ChartComponent.MS,
    60 * Pr500ChartComponent.MS,
    2 * 60 * Pr500ChartComponent.MS,
    5 * 60 * Pr500ChartComponent.MS,
    10 * 60 * Pr500ChartComponent.MS,
    15 * 60 * Pr500ChartComponent.MS,
    30 * 60 * Pr500ChartComponent.MS,
    3600 * Pr500ChartComponent.MS,
    2 * 3600 * Pr500ChartComponent.MS,
    3 * 3600 * Pr500ChartComponent.MS,
    4 * 3600 * Pr500ChartComponent.MS,
    6 * 3600 * Pr500ChartComponent.MS,
    12 * 3600 * Pr500ChartComponent.MS,
    Pr500ChartComponent.DAY,
    2 * Pr500ChartComponent.DAY,
    7 * Pr500ChartComponent.DAY,
    14 * Pr500ChartComponent.DAY,
    30 * Pr500ChartComponent.DAY,
    90 * Pr500ChartComponent.DAY,
    180 * Pr500ChartComponent.DAY,
    365 * Pr500ChartComponent.DAY,
  ];

  /** El menor paso “redondo” que deja a lo sumo `maxTicks` intervalos en el rango. */
  private static pickTimeStepMs(spanMs: number, maxTicks: number): number {
    const minStep = spanMs / Math.max(maxTicks, 2);
    for (const s of Pr500ChartComponent.TIME_STEP_CANDIDATES_MS) {
      if (s >= minStep * 0.98) return s;
    }
    return Math.ceil(minStep / Pr500ChartComponent.DAY) * Pr500ChartComponent.DAY;
  }

  private formatTimeAxisLabel(tMs: number, spanMs: number): string {
    const d = new Date(tMs);
    if (spanMs <= 10 * 60 * Pr500ChartComponent.MS) {
      return d.toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    if (spanMs <= 6 * 3600 * Pr500ChartComponent.MS) {
      return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    if (spanMs <= 72 * 3600 * Pr500ChartComponent.MS) {
      return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    if (spanMs <= 21 * Pr500ChartComponent.DAY) {
      return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  private mergeTimeEndpoints(epochs: number[], t0: number, t1: number, spanMs: number): number[] {
    const merged = [...epochs];
    const gap = Math.max(spanMs * 0.025, 45_000);
    merged.sort((a, b) => a - b);
    if (merged.length === 0) return [t0, t1];
    if (merged[0] - t0 > gap) merged.unshift(t0);
    if (t1 - merged[merged.length - 1] > gap) merged.push(t1);
    return [...new Set(merged)].sort((a, b) => a - b);
  }

  rebuildChartGeometry(): void {
    const pts = chartZoomHostSlice(this, this.displayPoints);
    this.zoomedPoints = pts;
    if (pts.length === 0) {
      this.pressurePath = '';
      this.pressureAreaPath = '';
      this.tempPath = '';
      this.superheatPath = '';
      this.hasTempAxis = false;
      this.tempAxisTicks = [];
      this.plot.x1 = 99.5;
      this.timeLabels = [];
      this.yAxisTicks = [];
      this.yGridLines = [];
      this.xGridLines = [];
      this.activityRects = [];
      this.pressureTrendSegs = [];
      this.pressureMotorDots = [];
      this.cursorMotorBackground = '';
      this.cursorMotorTitle = '';
      this.comp1StepPath = '';
      this.comp2StepPath = '';
      this.comp3StepPath = '';
      this.alarmStepPath = '';
      this.cursorActive = false;
      this.motorStatsRange = Pr500ChartComponent.emptyMotorStats();
      this.motorStatsVisible = Pr500ChartComponent.emptyMotorStats();
      this.motorSampleMedianMs = null;
      return;
    }
    const t0 = new Date(pts[0].created_at).getTime();
    const t1 = new Date(pts[pts.length - 1].created_at).getTime();
    const span = Math.max(t1 - t0, 60_000);
    this.zoomStartMs = t0;
    this.zoomSpanMs = span;

    let minP = Infinity;
    let maxP = -Infinity;
    const toY = (bar: number) => (this.pressureDisplayPsi ? bar * PR500_PSI_PER_BAR : bar);
    for (const p of pts) {
      if (Number.isFinite(p.pressure_bar)) {
        const yv = toY(p.pressure_bar);
        minP = Math.min(minP, yv);
        maxP = Math.max(maxP, yv);
      }
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
      minP = 0;
      maxP = 4;
    }
    const pad = Math.max((maxP - minP) * 0.08, this.pressureDisplayPsi ? 0.5 : 0.02);
    this.pMin = minP - pad;
    this.pMax = maxP + pad;

    let minT = Infinity;
    let maxT = -Infinity;
    for (const p of pts) {
      if (this.showTempSuction && p.temp_suction_c != null && Number.isFinite(p.temp_suction_c)) {
        minT = Math.min(minT, p.temp_suction_c);
        maxT = Math.max(maxT, p.temp_suction_c);
      }
      if (this.showSuperheat && p.superheat_c != null && Number.isFinite(p.superheat_c)) {
        minT = Math.min(minT, p.superheat_c);
        maxT = Math.max(maxT, p.superheat_c);
      }
    }
    this.hasTempAxis = Number.isFinite(minT) && Number.isFinite(maxT);
    this.plot.x1 = this.hasTempAxis ? 86.5 : 99.5;
    const { x0, x1, y0, y1 } = this.plot;
    const plotW = x1 - x0;
    const plotH = y1 - y0;
    const xAt = (iso: string) => {
      const tx = new Date(iso).getTime();
      return x0 + ((tx - t0) / span) * plotW;
    };

    const pSpan = this.pMax - this.pMin || 1;
    const yAtVal = (val: number) => {
      return y0 + (1 - (val - this.pMin) / pSpan) * plotH;
    };
    const parts: string[] = [];
    let firstX = 0;
    let lastX = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = xAt(p.created_at);
      const y = yAtVal(toY(p.pressure_bar));
      if (i === 0) firstX = x;
      lastX = x;
      parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
    }
    this.pressurePath = parts.join(' ');
    this.pressureAreaPath = `${this.pressurePath} L${lastX.toFixed(2)},${y1} L${firstX.toFixed(2)},${y1} Z`;

    this.pressureTrendSegs = [];
    if (this.chartStylePreset === 'trend' && this.showPressure && pts.length >= 2) {
      const eps = this.pressureDisplayPsi ? 0.04 : 0.0015;
      for (let i = 0; i < pts.length - 1; i++) {
        const v0 = toY(pts[i].pressure_bar);
        const v1 = toY(pts[i + 1].pressure_bar);
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;
        const d = v1 - v0;
        const trend = d > eps ? 'up' : d < -eps ? 'down' : 'flat';
        this.pressureTrendSegs.push({
          x1: xAt(pts[i].created_at),
          y1: yAtVal(v0),
          x2: xAt(pts[i + 1].created_at),
          y2: yAtVal(v1),
          trend,
        });
      }
    }
    this.rebuildPressureMotorDots(pts, xAt, yAtVal);

    this.tempPath = '';
    this.superheatPath = '';
    this.tempAxisTicks = [];
    if (this.hasTempAxis) {
      const tPad = Math.max((maxT - minT) * 0.1, 0.6);
      this.tMin = minT - tPad;
      this.tMax = maxT + tPad;
      const tSpan = this.tMax - this.tMin || 1;
      const yAtT = (tc: number) => y0 + (1 - (tc - this.tMin) / tSpan) * plotH;

      const buildSegmentedPath = (pick: (row: Pr500ReadingRow) => number | null | undefined): string => {
        const seg: string[] = [];
        let penUp = true;
        for (let i = 0; i < pts.length; i++) {
          const row = pts[i];
          const v = pick(row);
          if (v == null || !Number.isFinite(v)) {
            penUp = true;
            continue;
          }
          const xx = xAt(row.created_at);
          const yy = yAtT(v);
          seg.push(`${penUp ? 'M' : 'L'}${xx.toFixed(2)},${yy.toFixed(2)}`);
          penUp = false;
        }
        return seg.join(' ');
      };

      if (this.showTempSuction) this.tempPath = buildSegmentedPath((r) => r.temp_suction_c);
      if (this.showSuperheat) this.superheatPath = buildSegmentedPath((r) => r.superheat_c);

      const tStep = Pr500ChartComponent.niceStep(tSpan, 5);
      const firstTT = Math.ceil(this.tMin / tStep) * tStep;
      const tticks: { y: number; label: string; markX0: number; markX1: number }[] = [];
      for (let v = firstTT; v <= this.tMax + tStep * 0.001; v += tStep) {
        if (v < this.tMin - tStep * 0.001) continue;
        const yp = yAtT(v);
        if (yp < y0 - 0.5 || yp > y1 + 0.5) continue;
        tticks.push({
          y: yp,
          label: `${v.toFixed(1)}°`,
          markX0: x1,
          markX1: x1 + 1.15,
        });
        if (tticks.length >= 8) break;
      }
      if (tticks.length === 0) {
        tticks.push({
          y: yAtT(this.tMax),
          label: `${this.tMax.toFixed(1)}°`,
          markX0: x1,
          markX1: x1 + 1.15,
        });
        tticks.push({
          y: yAtT(this.tMin),
          label: `${this.tMin.toFixed(1)}°`,
          markX0: x1,
          markX1: x1 + 1.15,
        });
      }
      this.tempAxisTicks = tticks;
    }

    const step = Pr500ChartComponent.niceStep(pSpan, 6);
    const firstTick = Math.ceil(this.pMin / step) * step;
    const ticks: { y: number; label: string; markX0: number; markX1: number }[] = [];
    const grids: string[] = [];
    for (let v = firstTick; v <= this.pMax + step * 0.001; v += step) {
      if (v < this.pMin - step * 0.001) continue;
      const yp = yAtVal(v);
      if (yp < y0 - 0.5 || yp > y1 + 0.5) continue;
      const markX0 = x0 - 1.35;
      const markX1 = x0;
      ticks.push({
        y: yp,
        label: `${this.formatYAxisValue(v)} ${this.pressureYUnit}`,
        markX0,
        markX1,
      });
      grids.push(`M${x0.toFixed(2)},${yp.toFixed(2)}L${x1.toFixed(2)},${yp.toFixed(2)}`);
      if (ticks.length >= 9) break;
    }
    if (ticks.length === 0) {
      const markX0 = x0 - 1.35;
      const markX1 = x0;
      ticks.push({
        y: yAtVal(this.pMax),
        label: `${this.formatYAxisValue(this.pMax)} ${this.pressureYUnit}`,
        markX0,
        markX1,
      });
      ticks.push({
        y: yAtVal(this.pMin),
        label: `${this.formatYAxisValue(this.pMin)} ${this.pressureYUnit}`,
        markX0,
        markX1,
      });
      grids.push(`M${x0.toFixed(2)},${yAtVal(this.pMax).toFixed(2)}L${x1.toFixed(2)},${yAtVal(this.pMax).toFixed(2)}`);
      grids.push(`M${x0.toFixed(2)},${yAtVal(this.pMin).toFixed(2)}L${x1.toFixed(2)},${yAtVal(this.pMin).toFixed(2)}`);
    }
    this.yAxisTicks = ticks;
    this.yGridLines = grids;

    const timeAxis = buildChartTimeAxis({ x0, x1, y0, y1 }, t0, t1, span, xAt);
    this.timeLabels = timeAxis.timeLabels;
    this.xGridLines = timeAxis.xGridLines;
    this.activityRects = this.buildActivityRects(pts, xAt);
    const laneY = (lane: number) => {
      const base = 8 + lane * 20;
      return { yOn: base + 2.5, yOff: base + 11.5 };
    };
    if (this.showMotorStepChart && pts.length >= 1) {
      const l0 = laneY(0);
      const l1 = laneY(1);
      const l2 = laneY(2);
      const l3 = laneY(3);
      this.comp1StepPath = this.showComp1 ? Pr500ChartComponent.buildBooleanStepPath(pts, xAt, (p) => !!p.comp1_on, l0.yOn, l0.yOff) : '';
      this.comp2StepPath = this.showComp2 ? Pr500ChartComponent.buildBooleanStepPath(pts, xAt, (p) => !!p.comp2_on, l1.yOn, l1.yOff) : '';
      this.comp3StepPath = this.showComp3 ? Pr500ChartComponent.buildBooleanStepPath(pts, xAt, (p) => !!p.comp3_on, l2.yOn, l2.yOff) : '';
      this.alarmStepPath = this.showAlarm ? Pr500ChartComponent.buildBooleanStepPath(pts, xAt, (p) => !!p.alarm_on, l3.yOn, l3.yOff) : '';
    } else {
      this.comp1StepPath = '';
      this.comp2StepPath = '';
      this.comp3StepPath = '';
      this.alarmStepPath = '';
    }
    if (this.cursorActive) {
      this.updateCursorForX(this.cursorX);
    }
    this.updateMotorTimeSummaries(pts);
  }

  private buildActivityRects(pts: Pr500ReadingRow[], xAt: (iso: string) => number): { lane: number; x0: number; x1: number; on: boolean }[] {
    if (pts.length < 2) return [];
    const out: { lane: number; x0: number; x1: number; on: boolean }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const x0 = xAt(p.created_at);
      const x1 = xAt(pts[i + 1].created_at);
      out.push({ lane: 0, x0, x1, on: !!p.comp1_on });
      out.push({ lane: 1, x0, x1, on: !!p.comp2_on });
      out.push({ lane: 2, x0, x1, on: !!p.comp3_on });
      out.push({ lane: 3, x0, x1, on: !!p.alarm_on });
    }
    return out;
  }

  readonly motorLanes = [0, 1, 2, 3] as const;

  motorLaneBaselineY(lane: number): number {
    return 8 + lane * 20 + 11.5;
  }

  activityLaneVisible(lane: number): boolean {
    if (lane === 0) return this.showComp1;
    if (lane === 1) return this.showComp2;
    if (lane === 2) return this.showComp3;
    return this.showAlarm;
  }

  startChartPan(ev: MouseEvent): void {
    if (!this.zoomedPoints.length || !this.chartZoomIsActive) return;
    this.draggingPan = true;
    this.dragStartClientX = ev.clientX;
    this.dragStartLo = this.chartZoomLo;
    this.dragStartHi = this.chartZoomHi;
    ev.preventDefault();
  }

  onChartTouchStart(ev: TouchEvent): void {
    if (!this.zoomedPoints.length) return;
    this.noteTouchTapStart(ev);
    if (ev.touches.length >= 2) {
      const el = this.chartStage?.nativeElement;
      if (!el) return;
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      this.touchMode = 'pinch';
      this.touchStartDist = Math.abs(t1.clientX - t0.clientX);
      this.touchStartSpan = this.chartZoomHi - this.chartZoomLo;
      this.touchStartZoomLo = this.chartZoomLo;
      this.touchStartZoomHi = this.chartZoomHi;
      const centerX = (t0.clientX + t1.clientX) * 0.5;
      this.touchStartCenterNorm =
        chartPlotNormFromClientX(centerX, this.plot.x0, this.plot.x1, el) ?? 0.5;
      ev.preventDefault();
      return;
    }
    if (ev.touches.length === 1 && this.chartZoomIsActive) {
      const t = ev.touches[0];
      this.touchMode = 'pan';
      this.dragStartClientX = t.clientX;
      this.dragStartLo = this.chartZoomLo;
      this.dragStartHi = this.chartZoomHi;
      ev.preventDefault();
    }
  }

  onChartTouchMove(ev: TouchEvent): void {
    const el = this.chartStage?.nativeElement;
    if (!el || !this.zoomedPoints.length) return;
    this.noteTouchTapMove(ev);
    const r = el.getBoundingClientRect();
    if (r.width <= 1) return;

    if (this.touchMode === 'pinch' && ev.touches.length >= 2) {
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      const dist = Math.max(6, Math.abs(t1.clientX - t0.clientX));
      this.chartZoomLo = this.touchStartZoomLo;
      this.chartZoomHi = this.touchStartZoomHi;
      chartZoomHostPinch(this, this.touchStartDist / dist, this.touchStartCenterNorm);
      ev.preventDefault();
      return;
    }

    if (this.touchMode === 'pan' && ev.touches.length === 1) {
      const t = ev.touches[0];
      const dxNorm = (t.clientX - this.dragStartClientX) / r.width;
      if (Math.abs(dxNorm) > 0.002) this.touchPanDidNudge = true;
      chartZoomHostPanFromDrag(this, dxNorm, this.dragStartLo, this.dragStartHi);
      ev.preventDefault();
    }
  }

  onChartTouchEnd(ev: TouchEvent): void {
    this.touchMode = 'none';
    if (ev.touches.length === 0) {
      if (!this.touchSessionMultiFinger && !this.touchTapMoved && !this.touchPanDidNudge && ev.changedTouches.length > 0) {
        this.applyCursorFromClientX(ev.changedTouches[0].clientX);
      }
      this.touchSessionMultiFinger = false;
      this.touchTapMoved = false;
      this.touchPanDidNudge = false;
    }
  }

  onChartTouchCancel(): void {
    this.touchMode = 'none';
    this.touchSessionMultiFinger = false;
    this.touchTapMoved = false;
    this.touchPanDidNudge = false;
  }

  onChartMouseLeave(): void {
    this.cursorActive = false;
  }

  onChartMouseMove(ev: MouseEvent): void {
    if (!this.chartStage?.nativeElement || !this.zoomedPoints.length) return;
    this.applyCursorFromClientX(ev.clientX);
  }

  private updateCursorForX(x: number): void {
    if (!this.zoomedPoints.length) {
      this.cursorActive = false;
      return;
    }
    const px = Math.max(this.plot.x0, Math.min(this.plot.x1, x));
    this.cursorX = px;
    const ratio = (px - this.plot.x0) / Math.max(0.0001, this.plot.x1 - this.plot.x0);
    const targetMs = this.zoomStartMs + ratio * this.zoomSpanMs;
    let best = this.zoomedPoints[0];
    let bestD = Math.abs(new Date(best.created_at).getTime() - targetMs);
    for (let i = 1; i < this.zoomedPoints.length; i++) {
      const p = this.zoomedPoints[i];
      const d = Math.abs(new Date(p.created_at).getTime() - targetMs);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    let y: number;
    if (this.showPressure && Number.isFinite(best.pressure_bar)) {
      const yVal = this.pressureDisplayPsi ? best.pressure_bar * PR500_PSI_PER_BAR : best.pressure_bar;
      y = this.plot.y0 + (1 - (yVal - this.pMin) / Math.max(0.0001, this.pMax - this.pMin)) * (this.plot.y1 - this.plot.y0);
    } else if (this.hasTempAxis) {
      const tSpan = this.tMax - this.tMin || 1;
      let tv: number | null = null;
      if (this.showTempSuction && best.temp_suction_c != null && Number.isFinite(best.temp_suction_c)) {
        tv = best.temp_suction_c;
      } else if (this.showSuperheat && best.superheat_c != null && Number.isFinite(best.superheat_c)) {
        tv = best.superheat_c;
      }
      y =
        tv != null
          ? this.plot.y0 + (1 - (tv - this.tMin) / tSpan) * (this.plot.y1 - this.plot.y0)
          : (this.plot.y0 + this.plot.y1) / 2;
    } else {
      y = (this.plot.y0 + this.plot.y1) / 2;
    }
    this.cursorY = Math.max(this.plot.y0, Math.min(this.plot.y1, y));
    if (this.showPressure && this.chartStylePreset === 'trend') {
      const m = this.motorStatesFromRow(best);
      this.cursorMotorBackground = Pr500ChartComponent.motorConicGradient(m.c1, m.c2, m.c3);
      this.cursorMotorTitle = Pr500ChartComponent.motorDotTitle(m.c1, m.c2, m.c3);
    } else {
      this.cursorMotorBackground = '';
      this.cursorMotorTitle = '';
    }
    this.cursorTimeLabel = new Date(best.created_at).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    this.cursorPressureLabel =
      this.showPressure && Number.isFinite(best.pressure_bar)
        ? this.pressureDisplayPsi
          ? `${pr500BarToPsi(best.pressure_bar).toFixed(1)} psi`
          : `${best.pressure_bar.toFixed(2)} bar`
        : '';

    this.cursorTempLabel = '';
    if (this.hasTempAxis) {
      const bits: string[] = [];
      if (this.showTempSuction && best.temp_suction_c != null && Number.isFinite(best.temp_suction_c)) {
        bits.push(`Succión ${best.temp_suction_c.toFixed(1)} °C`);
      }
      if (this.showSuperheat && best.superheat_c != null && Number.isFinite(best.superheat_c)) {
        const warn = best.superheat_ok === false ? ' ⚠' : '';
        bits.push(`Rec. ${best.superheat_c.toFixed(1)} °C${warn}`);
      }
      this.cursorTempLabel = bits.join(' · ');
    }
  }

  cursorTooltipHeight(): number {
    const lines = (this.cursorPressureLabel ? 1 : 0) + (this.cursorTempLabel ? 1 : 0) + 1;
    if (lines <= 2) return 6.2;
    return 8.9;
  }

  /** Posición Y del renglón de hora en el tooltip del cursor (viewBox). */
  cursorTimeTextY(): number {
    const p = this.plot.y0;
    if (this.cursorPressureLabel && this.cursorTempLabel) return p + 8.15;
    if (this.cursorPressureLabel || this.cursorTempLabel) return p + 6;
    return p + 5.35;
  }

  lastRowSummary(): string {
    const r = this.latestReading;
    if (!r) return 'Sin datos en el rango.';
    const di = (v: boolean | null | undefined) =>
      v === null || v === undefined ? '—' : v ? 'OK' : 'FALLO';
    const pStr = this.pressureDisplayPsi
      ? `${pr500BarToPsi(r.pressure_bar).toFixed(1)} psi (${r.pressure_bar.toFixed(2)} bar)`
      : `${r.pressure_bar.toFixed(2)} bar`;
    const rh = this.runHoursSummaryLine(r);
    const tbits: string[] = [];
    if (r.temp_suction_c != null && Number.isFinite(r.temp_suction_c)) {
      tbits.push(`succión ${r.temp_suction_c.toFixed(1)} °C`);
    }
    if (r.superheat_c != null && Number.isFinite(r.superheat_c)) {
      tbits.push(`Rec. ${r.superheat_c.toFixed(1)} °C`);
    }
    const tExtra = tbits.length ? ` · ${tbits.join(', ')}` : '';
    const base = `Última lectura: ${pStr}${tExtra} · Compresores C1–C3 y alarma según leyenda · DI ${di(r.di1_ok)}/${di(r.di2_ok)}/${di(r.di3_ok)}/${di(r.di4_ok)}`;
    return rh ? `${base} · ${rh}` : base;
  }

  /** Texto compacto de horas marcha desde ms acumulados (última muestra del rango). */
  runHoursSummaryLine(r: Pr500ReadingRow): string {
    const h = (ms: number | null | undefined) =>
      ms != null && Number.isFinite(ms) && ms >= 0 ? (ms / 3_600_000).toFixed(1) : null;
    const a = h(r.comp1_run_ms);
    const b = h(r.comp2_run_ms);
    const c = h(r.comp3_run_ms);
    if (a == null && b == null && c == null) return '';
    return `Horas marcha acum.: C1 ${a ?? '—'} · C2 ${b ?? '—'} · C3 ${c ?? '—'}`;
  }

  readingCountLabel(): string {
    const n = this.readings.length;
    if (n === 0) return 'Sin puntos en el rango';
    const shown = this.displayPoints.length;
    if (shown < n) return `${n.toLocaleString('es-AR')} lecturas (${shown.toLocaleString('es-AR')} en el gráfico)`;
    return `${n.toLocaleString('es-AR')} lecturas`;
  }

  latestPressureText(): string {
    const L = this.latestReading;
    if (!L || !Number.isFinite(L.pressure_bar)) return '—';
    if (this.pressureDisplayPsi) {
      return `${pr500BarToPsi(L.pressure_bar).toFixed(1)} ${this.pressureYUnit}`;
    }
    return `${L.pressure_bar.toFixed(2)} ${this.pressureYUnit}`;
  }

  latestSuctionSummary(): string {
    const L = this.latestReading;
    if (!L || L.temp_suction_c == null || !Number.isFinite(L.temp_suction_c)) return '';
    return `Succión ${L.temp_suction_c.toFixed(1)} °C`;
  }

  latestSuperheatSummary(): string {
    const L = this.latestReading;
    if (!L || L.superheat_c == null || !Number.isFinite(L.superheat_c)) return '';
    const warn = L.superheat_ok === false ? ' · fuera de ventana' : '';
    return `Rec. ${L.superheat_c.toFixed(1)} °C${warn}`;
  }

  stateRectW(r: { x0: number; x1: number }): number {
    return Math.max(0.08, r.x1 - r.x0);
  }
}
