import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { CombistatoStoreService } from '../core/combistato-store.service';
import { ChartStylePreset } from '../core/models/dashboard.models';
import { buildChartTrendSegments, type ChartTrendSegment } from '../core/chart-trend';
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
  CHART_SVG_PRESERVE_ASPECT,
  CHART_TEMP_PLOT,
  CHART_TEMP_VIEWBOX_HEIGHT,
  chartPlotNormFromClientX,
  chartViewBoxXFromClientX,
} from '../core/chart-svg-coords';
import {
  buildChartTimeAxis,
  buildTempYAxisTicks,
  chartAxisMaxTimeLabels,
  CHART_ACTIVITY_TIME_AXIS,
  chartFormatTimeRangeLabel,
  type ChartPlotBounds,
  type ChartTimeLabel,
  type ChartYAxisTick,
} from '../core/chart-axis.utils';
import {
  chartPagePanelsDefaults,
  chartSectionHeightsDefaults,
  loadChartPagePanels,
  loadChartSectionHeights,
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

export interface CombistatoReadingRow {
  id: number;
  combistato_id: string;
  created_at: string;
  temp1_c: number;
  temp2_c: number | null;
  comp_on: boolean;
  fan_on: boolean;
  defrost_on: boolean;
  door_open: boolean;
}

const LS_PREFIX = 'ar-combistato-chart-series-v1:';
const MAX_FETCH = 8000;
const MAX_DRAW_POINTS = 1600;

@Component({
  selector: 'app-combistato-chart',
  templateUrl: './combistato-chart.component.html',
  styleUrls: ['./combistato-chart.component.scss'],
})
export class CombistatoChartComponent implements OnInit, OnDestroy {
  readonly environment = environment;

  combistatoId: string | null = null;
  combistatoName = 'Combistato';
  loading = false;
  error = '';

  filterFrom = '';
  filterTo = '';

  showTemp1 = true;
  showTemp2 = true;
  showComp = true;
  showFan = true;
  showDefrost = true;
  showDoor = true;
  showHistogram = true;

  private readonly chartStyleStorageKey = 'ar_combistato_chart_style_v1';
  chartStylePreset: ChartStylePreset = 'area';
  readonly chartStyleOptions: { value: ChartStylePreset; label: string }[] = [
    { value: 'area', label: 'Área (relleno suave)' },
    { value: 'line', label: 'Solo líneas' },
    { value: 'minimal', label: 'Minimal (limpio)' },
    { value: 'technical', label: 'Técnico (rejilla)' },
    { value: 'trend', label: 'Tendencia (color por subida/bajada)' },
  ];
  sectionHeights = chartSectionHeightsDefaults();

  private readonly layoutStorageKey = 'ar_combistato_chart_panels_v1';
  sidePanelOpen = chartPagePanelsDefaults().sideOpen;
  extrasPanelOpen = false;

  readings: CombistatoReadingRow[] = [];
  displayPoints: CombistatoReadingRow[] = [];

  /** Misma geometría que PR500 (viewBox panorámico 0 0 100 × 58). */
  readonly plot: ChartPlotBounds = { ...CHART_TEMP_PLOT };
  readonly chartViewBoxHeight = CHART_TEMP_VIEWBOX_HEIGHT;
  tempPath1 = '';
  tempPath2 = '';
  tempAreaPath1 = '';
  tempAreaPath2 = '';
  tempTrendSegs1: ChartTrendSegment[] = [];
  tempTrendSegs2: ChartTrendSegment[] = [];
  tempMin = -30;
  tempMax = 10;
  yAxisTicks: ChartYAxisTick[] = [];
  yGridLines: string[] = [];
  xGridLines: string[] = [];
  timeLabels: ChartTimeLabel[] = [];
  timeRangeLabel = '';
  readonly activityTimeAxis = CHART_ACTIVITY_TIME_AXIS;

  /** Franjas actividad: [ { lane, x0, x1, on } ] en coords 0–100 */
  activityRects: { lane: number; x0: number; x1: number; on: boolean }[] = [];

  /** Histograma temp1+temp2 en rango visible */
  histBars: { x: number; h: number; w: number }[] = [];
  histMaxCount = 1;
  histLo = 0;
  histHi = 0;
  readonly histViewBoxHeight = 44;

  chartFullscreen = false;
  chartZoomLo = 0;
  chartZoomHi = 1;
  cursorActive = false;
  cursorX = 0;
  cursorY1 = 0;
  cursorY2 = 0;
  cursorLabelTime = '';
  cursorLabelTemp1 = '';
  cursorLabelTemp2 = '';
  private zoomStartMs = 0;
  private zoomSpanMs = 1;
  private zoomedPoints: CombistatoReadingRow[] = [];
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
  private touchTapStartX = 0;
  private touchTapStartY = 0;
  private touchTapMoved = false;
  private touchSessionMultiFinger = false;
  private touchPanDidNudge = false;

  pdfExporting = false;

  @ViewChild('chartStage', { static: false })
  chartStage?: ElementRef<HTMLElement>;

  @ViewChild('chartPdfCapture') chartPdfCapture?: ElementRef<HTMLElement>;

  private sub?: Subscription;
  private realtimeChannel: RealtimeChannel | null = null;
  private axisLabelBucket = chartAxisMaxTimeLabels();

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService,
    private readonly combistatoStore: CombistatoStoreService
  ) {}

  ngOnInit(): void {
    this.sub = this.route.queryParamMap.subscribe((q) => {
      const id = q.get('combistatoId');
      this.combistatoId = id && id.length > 10 ? id : null;
      this.initDefaultRange();
      this.loadSeriesPrefs();
      this.loadChartStylePreset();
      this.loadChartPanels();
      if (this.combistatoId) {
        void this.loadAll();
      } else {
        this.error = 'Falta combistatoId en la URL (ej. ?combistatoId=…).';
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.teardownRealtime();
    const el = this.chartStage?.nativeElement;
    if (el && isCurrentFullscreen(el)) {
      void exitFullscreenBestEffort();
    }
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onChartFullscreenChange(): void {
    const el = this.chartStage?.nativeElement;
    this.chartFullscreen = isCurrentFullscreen(el ?? null);
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

  private lsKey(): string {
    return `${LS_PREFIX}${this.combistatoId ?? 'none'}`;
  }

  private loadSeriesPrefs(): void {
    if (!this.combistatoId) return;
    try {
      const raw = localStorage.getItem(this.lsKey());
      if (!raw) return;
      const o = JSON.parse(raw) as Record<string, unknown>;
      const b = (k: string, def: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : def);
      this.showTemp1 = b('t1', true);
      this.showTemp2 = b('t2', true);
      this.showComp = b('c', true);
      this.showFan = b('f', true);
      this.showDefrost = b('d', true);
      this.showDoor = b('p', true);
      this.showHistogram = b('h', true);
    } catch {
      /* ignore */
    }
  }

  persistSeriesPrefs(): void {
    if (!this.combistatoId) return;
    const o = {
      t1: this.showTemp1,
      t2: this.showTemp2,
      c: this.showComp,
      f: this.showFan,
      d: this.showDefrost,
      p: this.showDoor,
      h: this.showHistogram,
    };
    try {
      localStorage.setItem(this.lsKey(), JSON.stringify(o));
    } catch {
      /* ignore */
    }
    this.rebuildChartGeometry();
  }

  private initDefaultRange(): void {
    const to = new Date();
    const from = new Date(to.getTime() - 48 * 3600 * 1000);
    this.filterTo = this.toLocalInput(to);
    this.filterFrom = this.toLocalInput(from);
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
    if (!this.combistatoId || !environment.deviceCloudSync || !isSupabaseConfigured()) {
      this.error = 'Nube no configurada o sesión no disponible.';
      return;
    }
    this.loading = true;
    this.error = '';
    this.teardownRealtime();
    try {
      const session = await this.auth.getSession();
      if (!session?.user) {
        void this.router.navigate(['/login']);
        return;
      }
      const chartsOk = await this.assertChartsAccess();
      if (!chartsOk) {
        this.readings = [];
        this.displayPoints = [];
        return;
      }
      const { data: meta, error: eMeta } = await this.auth.client
        .from('combistatos')
        .select('name')
        .eq('id', this.combistatoId)
        .maybeSingle();
      if (eMeta) {
        this.error = eMeta.message;
        return;
      }
      this.combistatoName = (meta as { name?: string } | null)?.name?.trim() || 'Combistato';

      const fromD = this.parseLocalInput(this.filterFrom);
      const toD = this.parseLocalInput(this.filterTo);
      if (!fromD || !toD || fromD >= toD) {
        this.error = 'Revisá el rango de fechas (desde < hasta).';
        return;
      }
      const fromIso = fromD.toISOString();
      const toIso = toD.toISOString();

      const { data: rows, error: eRows } = await this.auth.client
        .from('combistato_readings')
        .select(
          'id, combistato_id, created_at, temp1_c, temp2_c, comp_on, fan_on, defrost_on, door_open'
        )
        .eq('combistato_id', this.combistatoId)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: true })
        .limit(MAX_FETCH);

      if (eRows) {
        if (eRows.message?.includes('Could not find') || eRows.code === '42P01') {
          this.error =
            'Falta la tabla de historial. Ejecutá en Supabase el SQL `035_combistato_readings.sql` y redeployá `ingest-reading`.';
        } else {
          this.error = eRows.message;
        }
        this.readings = [];
        this.displayPoints = [];
        return;
      }
      this.readings = (rows ?? []) as CombistatoReadingRow[];
      this.downsample();
      if (this.chartZoomHi <= this.chartZoomLo || this.displayPoints.length < 3) {
        this.chartZoomLo = 0;
        this.chartZoomHi = 1;
      }
      this.rebuildChartGeometry();
      this.setupRealtime();
    } finally {
      this.loading = false;
    }
  }

  private async assertChartsAccess(): Promise<boolean> {
    const id = this.combistatoId;
    if (!id) return false;
    const cached = this.combistatoStore.snapshot.find((c) => c.id === id);
    if (cached) {
      if (!this.combistatoStore.canChartsCombistato(cached)) {
        this.error = 'No tenés permiso para ver el gráfico de este PRO300.';
        return false;
      }
      return true;
    }
    const { data, error } = await this.auth.client.rpc('user_can_charts_combistato', {
      p_combistato_id: id,
    });
    if (error || !data) {
      this.error = error?.message ?? 'No tenés permiso para ver el gráfico de este PRO300.';
      return false;
    }
    return true;
  }

  private teardownRealtime(): void {
    if (this.realtimeChannel != null) {
      void this.auth.client.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }

  private setupRealtime(): void {
    this.teardownRealtime();
    const id = this.combistatoId;
    if (!id || !environment.deviceCloudSync || !isSupabaseConfigured()) return;
    this.realtimeChannel = this.auth.client
      .channel(`combistato-chart:${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'combistato_readings',
          filter: `combistato_id=eq.${id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          this.appendRealtimeReading(row);
        }
      )
      .subscribe();
  }

  private appendRealtimeReading(row: Record<string, unknown>): void {
    const id = typeof row['id'] === 'number' ? row['id'] : Number(row['id']);
    const createdAt = typeof row['created_at'] === 'string' ? row['created_at'] : '';
    const temp1 = typeof row['temp1_c'] === 'number' ? row['temp1_c'] : null;
    if (!Number.isFinite(id) || !createdAt || temp1 == null) return;

    const fromD = this.parseLocalInput(this.filterFrom);
    const toD = this.parseLocalInput(this.filterTo);
    const at = new Date(createdAt).getTime();
    if (fromD && toD && (at < fromD.getTime() || at > toD.getTime())) return;

    if (this.readings.some((r) => r.id === id)) return;

    const reading: CombistatoReadingRow = {
      id,
      combistato_id: this.combistatoId!,
      created_at: createdAt,
      temp1_c: temp1,
      temp2_c: typeof row['temp2_c'] === 'number' ? row['temp2_c'] : null,
      comp_on: row['comp_on'] === true,
      fan_on: row['fan_on'] === true,
      defrost_on: row['defrost_on'] === true,
      door_open: row['door_open'] === true,
    };

    this.readings = [...this.readings, reading];
    if (this.readings.length > MAX_FETCH) {
      this.readings = this.readings.slice(this.readings.length - MAX_FETCH);
    }
    this.downsample();
    this.rebuildChartGeometry();
  }

  private downsample(): void {
    const src = this.readings;
    if (src.length <= MAX_DRAW_POINTS) {
      this.displayPoints = src.slice();
      return;
    }
    const step = Math.ceil(src.length / MAX_DRAW_POINTS);
    const out: CombistatoReadingRow[] = [];
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

  applyPresetRange(hours: 24 | 48 | 168): void {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    this.filterTo = this.toLocalInput(to);
    this.filterFrom = this.toLocalInput(from);
    this.resetChartZoom();
    void this.loadAll();
  }

  loadChartStylePreset(): void {
    try {
      const v = localStorage.getItem(this.chartStyleStorageKey) as ChartStylePreset | null;
      if (v && this.chartStyleOptions.some((o) => o.value === v)) {
        this.chartStylePreset = v;
      }
    } catch {
      this.chartStylePreset = 'area';
    }
  }

  onChartStyleChange(): void {
    try {
      localStorage.setItem(this.chartStyleStorageKey, this.chartStylePreset);
    } catch {
      /* ignore */
    }
    this.rebuildChartGeometry();
  }

  chartShowsAreaFill(): boolean {
    return this.chartStylePreset === 'area' || this.chartStylePreset === 'technical';
  }

  toggleMainChartTall(): void {
    this.sectionHeights.mainTall = !this.sectionHeights.mainTall;
    this.persistChartPanels();
  }

  toggleHistChartTall(): void {
    this.sectionHeights.histTall = !this.sectionHeights.histTall;
    this.persistChartPanels();
  }

  toggleActivityChartTall(): void {
    this.sectionHeights.activityTall = !this.sectionHeights.activityTall;
    this.persistChartPanels();
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
    this.sectionHeights = loadChartSectionHeights(this.layoutStorageKey);
  }

  private persistChartPanels(): void {
    persistChartPagePanels(this.layoutStorageKey, {
      sideOpen: this.sidePanelOpen,
      extrasOpen: this.extrasPanelOpen,
      heights: { ...this.sectionHeights },
    });
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
      this.displayPoints.length > 0,
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
        title: 'Historial Combistato',
        deviceName: this.combistatoName,
        rangeLabel: this.pdfRangeLabel(),
        styleLabel: chartStyleLabel(this.chartStyleOptions, this.chartStylePreset),
        rows: this.readings as unknown as Record<string, unknown>[],
        columns: [
          { header: 'Fecha', cell: (r) => pdfCellDate(r['created_at']) },
          { header: 'S1 °C', cell: (r) => pdfCellNum(r['temp1_c'], 2) },
          { header: 'S2 °C', cell: (r) => pdfCellNum(r['temp2_c'], 2) },
          { header: 'Comp', cell: (r) => pdfCellOn(r['comp_on']) },
          { header: 'Fan', cell: (r) => pdfCellOn(r['fan_on']) },
          { header: 'Defrost', cell: (r) => pdfCellOn(r['defrost_on']) },
          { header: 'Puerta', cell: (r) => pdfCellOn(r['door_open']) },
        ],
        fileSlug: this.combistatoName || 'combistato',
        captureEl: this.chartPdfCapture?.nativeElement,
      });
    } finally {
      this.pdfExporting = false;
    }
  }

  private pdfRangeLabel(): string {
    return `${this.filterFrom || '—'} → ${this.filterTo || '—'}`;
  }

  rebuildChartGeometry(): void {
    const pts = chartZoomHostSlice(this, this.displayPoints);
    this.zoomedPoints = pts;
    if (pts.length === 0) {
      this.tempPath1 = '';
      this.tempPath2 = '';
      this.tempAreaPath1 = '';
      this.tempAreaPath2 = '';
      this.tempTrendSegs1 = [];
      this.tempTrendSegs2 = [];
      this.yAxisTicks = [];
      this.yGridLines = [];
      this.xGridLines = [];
      this.timeLabels = [];
      this.timeRangeLabel = '';
      this.activityRects = [];
      this.histBars = [];
      this.histMaxCount = 1;
      this.histLo = 0;
      this.histHi = 0;
      this.cursorActive = false;
      return;
    }

    const t0 = new Date(pts[0].created_at).getTime();
    const t1 = new Date(pts[pts.length - 1].created_at).getTime();
    const span = Math.max(t1 - t0, 60_000);
    this.zoomStartMs = t0;
    this.zoomSpanMs = span;

    const xAt = (iso: string) => {
      const tx = new Date(iso).getTime();
      return this.plot.x0 + ((tx - t0) / span) * (this.plot.x1 - this.plot.x0);
    };

    let minT = Infinity;
    let maxT = -Infinity;
    for (const p of pts) {
      if (this.showTemp1 && Number.isFinite(p.temp1_c)) {
        minT = Math.min(minT, p.temp1_c);
        maxT = Math.max(maxT, p.temp1_c);
      }
      if (this.showTemp2 && p.temp2_c != null && Number.isFinite(p.temp2_c)) {
        minT = Math.min(minT, p.temp2_c);
        maxT = Math.max(maxT, p.temp2_c);
      }
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT)) {
      minT = -20;
      maxT = 5;
    }
    const pad = Math.max((maxT - minT) * 0.08, 0.5);
    this.tempMin = minT - pad;
    this.tempMax = maxT + pad;
    const tr = this.tempMax - this.tempMin || 1;
    const yAt = (c: number) => this.plot.y1 - ((c - this.tempMin) / tr) * (this.plot.y1 - this.plot.y0);

    const pathFor = (getter: (p: CombistatoReadingRow) => number | null | undefined, show: boolean) => {
      if (!show) return '';
      let d = '';
      let first = true;
      for (const p of pts) {
        const v = getter(p);
        if (v == null || Number.isNaN(v)) continue;
        const x = xAt(p.created_at);
        const y = yAt(v);
        d += first ? `M${x.toFixed(2)},${y.toFixed(2)}` : ` L${x.toFixed(2)},${y.toFixed(2)}`;
        first = false;
      }
      return d;
    };

    this.tempPath1 = pathFor((p) => p.temp1_c, this.showTemp1);
    this.tempPath2 = pathFor((p) => p.temp2_c, this.showTemp2);
    const closeArea = (path: string) =>
      path ? `${path} L${this.plot.x1.toFixed(2)},${this.plot.y1.toFixed(2)} L${this.plot.x0.toFixed(2)},${this.plot.y1.toFixed(2)} Z` : '';
    this.tempAreaPath1 = closeArea(this.tempPath1);
    this.tempAreaPath2 = closeArea(this.tempPath2);

    const eps = Math.max((this.tempMax - this.tempMin) * 0.002, 0.02);
    if (this.chartStylePreset === 'trend' && this.showTemp1) {
      this.tempTrendSegs1 = buildChartTrendSegments(
        pts.map((p) => ({ x: xAt(p.created_at), y: p.temp1_c })),
        eps
      );
    } else {
      this.tempTrendSegs1 = [];
    }
    if (this.chartStylePreset === 'trend' && this.showTemp2) {
      this.tempTrendSegs2 = buildChartTrendSegments(
        pts.map((p) => ({ x: xAt(p.created_at), y: p.temp2_c })),
        eps
      );
    } else {
      this.tempTrendSegs2 = [];
    }

    const yAxis = buildTempYAxisTicks(this.plot, this.tempMin, this.tempMax, yAt);
    this.yAxisTicks = yAxis.ticks;
    this.yGridLines = yAxis.gridLines;
    const timeAxis = buildChartTimeAxis(this.plot, t0, t1, span, xAt);
    this.timeLabels = timeAxis.timeLabels;
    this.xGridLines = timeAxis.xGridLines;
    this.timeRangeLabel = chartFormatTimeRangeLabel(t0, t1);

    const lanes: { key: keyof CombistatoReadingRow; show: boolean; lane: number }[] = [
      { key: 'comp_on', show: this.showComp, lane: 0 },
      { key: 'fan_on', show: this.showFan, lane: 1 },
      { key: 'defrost_on', show: this.showDefrost, lane: 2 },
      { key: 'door_open', show: this.showDoor, lane: 3 },
    ];

    const rects: { lane: number; x0: number; x1: number; on: boolean }[] = [];
    for (const { key, show, lane } of lanes) {
      if (!show) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const x0 = xAt(pts[i].created_at);
        const x1 = xAt(pts[i + 1].created_at);
        const on = Boolean(pts[i][key]);
        rects.push({ lane, x0, x1, on });
      }
    }
    this.activityRects = rects;

    this.buildHistogram(pts);
    if (this.cursorActive) this.updateCursorForX(this.cursorX);
  }

  activityLaneVisible(lane: number): boolean {
    if (lane === 0) return this.showComp;
    if (lane === 1) return this.showFan;
    if (lane === 2) return this.showDefrost;
    return this.showDoor;
  }

  stateRectW(r: { x0: number; x1: number }): number {
    return Math.max(0.08, r.x1 - r.x0);
  }

  cursorTooltipHeight(): number {
    let rows = 1;
    if (this.cursorLabelTemp1) rows++;
    if (this.cursorLabelTemp2 && this.showTemp2) rows++;
    return rows * 2.1 + 1.4;
  }

  cursorTimeTextY(): number {
    let y = this.plot.y0 + 3.7;
    if (this.cursorLabelTemp1) y += 2.15;
    if (this.cursorLabelTemp2 && this.showTemp2) y += 2.15;
    return y + 2.15;
  }

  private buildHistogram(pts: CombistatoReadingRow[]): void {
    this.histBars = [];
    this.histMaxCount = 1;
    this.histLo = 0;
    this.histHi = 0;
    if (!this.showHistogram || pts.length < 2) return;

    const vals: number[] = [];
    for (const p of pts) {
      if (this.showTemp1 && Number.isFinite(p.temp1_c)) vals.push(p.temp1_c);
      if (this.showTemp2 && p.temp2_c != null && Number.isFinite(p.temp2_c)) vals.push(p.temp2_c);
    }
    if (vals.length < 2) return;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < 0.2) {
      lo -= 0.5;
      hi += 0.5;
    }
    this.histLo = lo;
    this.histHi = hi;
    const bins = 24;
    const w = 100 / bins;
    const counts = new Array(bins).fill(0);
    for (const v of vals) {
      const t = (v - lo) / (hi - lo || 1);
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
      counts[idx]++;
    }
    this.histMaxCount = Math.max(1, ...counts);
    for (let i = 0; i < bins; i++) {
      const ratio = counts[i] / this.histMaxCount;
      this.histBars.push({ x: i * w, h: ratio, w: w * 0.92 });
    }
  }

  backToApp(): void {
    void this.router.navigate(['/dispositivos']);
  }

  barDisplayHeight(ratio: number): number {
    return Math.max(0.6, ratio * 34);
  }

  histBarY(ratio: number): number {
    return 44 - this.barDisplayHeight(ratio);
  }

  histTempLabel(v: number): string {
    const span = this.histHi - this.histLo;
    return `${v.toFixed(span < 2 ? 1 : 0)}°`;
  }

  startTempPan(ev: MouseEvent): void {
    if (!this.zoomedPoints.length || !this.chartZoomIsActive) return;
    this.draggingPan = true;
    this.dragStartClientX = ev.clientX;
    this.dragStartLo = this.chartZoomLo;
    this.dragStartHi = this.chartZoomHi;
    ev.preventDefault();
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

  applyCursorFromClientX(clientX: number): void {
    const stage = this.chartStage?.nativeElement;
    if (!stage || !this.zoomedPoints.length) return;
    const x = chartViewBoxXFromClientX(clientX, stage);
    if (x == null) return;
    this.cursorActive = true;
    this.updateCursorForX(x);
  }

  onTempTouchStart(ev: TouchEvent): void {
    if (!this.zoomedPoints.length) return;
    this.noteTouchTapStart(ev);
    const chartEl = this.chartStage?.nativeElement;
    if (!chartEl) return;
    const r = chartEl.getBoundingClientRect();
    if (ev.touches.length >= 2) {
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      this.touchMode = 'pinch';
      this.touchStartDist = Math.abs(t1.clientX - t0.clientX);
      this.touchStartSpan = this.chartZoomHi - this.chartZoomLo;
      this.touchStartZoomLo = this.chartZoomLo;
      this.touchStartZoomHi = this.chartZoomHi;
      const centerX = (t0.clientX + t1.clientX) * 0.5;
      this.touchStartCenterNorm =
        chartPlotNormFromClientX(centerX, this.plot.x0, this.plot.x1, chartEl) ?? 0.5;
      ev.preventDefault();
      return;
    }
    if (ev.touches.length === 1 && this.chartZoomIsActive) {
      this.touchMode = 'pan';
      this.dragStartClientX = ev.touches[0].clientX;
      this.dragStartLo = this.chartZoomLo;
      this.dragStartHi = this.chartZoomHi;
      ev.preventDefault();
    }
  }

  onTempTouchMove(ev: TouchEvent): void {
    const chartEl = this.chartStage?.nativeElement;
    if (!chartEl || !this.zoomedPoints.length) return;
    this.noteTouchTapMove(ev);
    const r = chartEl.getBoundingClientRect();
    if (r.width <= 1) return;

    if (this.touchMode === 'pinch' && ev.touches.length >= 2) {
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      const dist = Math.max(6, Math.abs(t1.clientX - t0.clientX));
      const centerX = (t0.clientX + t1.clientX) * 0.5;
      const centerNorm = chartPlotNormFromClientX(centerX, this.plot.x0, this.plot.x1, chartEl) ?? 0.5;
      this.chartZoomLo = this.touchStartZoomLo;
      this.chartZoomHi = this.touchStartZoomHi;
      chartZoomHostPinch(this, this.touchStartDist / dist, centerNorm);
      ev.preventDefault();
      return;
    }

    if (this.touchMode === 'pan' && ev.touches.length === 1) {
      const dxNorm = (ev.touches[0].clientX - this.dragStartClientX) / r.width;
      if (Math.abs(dxNorm) > 0.002) this.touchPanDidNudge = true;
      chartZoomHostPanFromDrag(this, dxNorm, this.dragStartLo, this.dragStartHi);
      ev.preventDefault();
    }
  }

  onTempTouchEnd(ev: TouchEvent): void {
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

  onTempTouchCancel(): void {
    this.touchMode = 'none';
    this.touchSessionMultiFinger = false;
    this.touchTapMoved = false;
    this.touchPanDidNudge = false;
  }

  onTempMouseLeave(): void {
    this.cursorActive = false;
  }

  onTempMouseMove(ev: MouseEvent): void {
    if (!this.chartStage?.nativeElement || !this.zoomedPoints.length) return;
    this.applyCursorFromClientX(ev.clientX);
  }

  private updateCursorForX(x: number): void {
    if (!this.zoomedPoints.length) {
      this.cursorActive = false;
      return;
    }
    const cx = Math.max(this.plot.x0, Math.min(this.plot.x1, x));
    this.cursorX = cx;
    const ratio = (cx - this.plot.x0) / Math.max(0.0001, this.plot.x1 - this.plot.x0);
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

    const tr = this.tempMax - this.tempMin || 1;
    const yAt = (v: number) =>
      this.plot.y1 - ((v - this.tempMin) / tr) * (this.plot.y1 - this.plot.y0);
    this.cursorY1 = yAt(best.temp1_c);
    this.cursorY2 = best.temp2_c != null && Number.isFinite(best.temp2_c) ? yAt(best.temp2_c) : this.cursorY1;
    this.cursorLabelTemp1 = Number.isFinite(best.temp1_c) ? `${best.temp1_c.toFixed(2)} °C` : '';
    this.cursorLabelTemp2 = best.temp2_c != null && Number.isFinite(best.temp2_c) ? `${best.temp2_c.toFixed(2)} °C` : '';
    this.cursorLabelTime = new Date(best.created_at).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}
