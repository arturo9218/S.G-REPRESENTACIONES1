import {
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { ChartStylePreset } from '../core/models/dashboard.models';
import { environment } from '../../environments/environment';
import { isSupabaseConfigured } from '../core/supabase-config';
import { mergeDataloggerParams, type DataloggerFormModel } from '../datalogger/datalogger-params.defaults';
import { correctDataloggerReadingRow } from '../datalogger/datalogger-calibration.utils';
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
  downloadDeviceChartPdf,
  pdfCellDate,
  pdfCellNum,
} from '../core/device-chart-pdf';

export interface DataloggerReadingRow {
  id: number;
  datalogger_id: string;
  created_at: string;
  temp1_c?: number | null;
  temp2_c?: number | null;
  temp3_c?: number | null;
  temp4_c?: number | null;
  temp5_c?: number | null;
  temp6_c?: number | null;
  current1_a?: number | null;
  current2_a?: number | null;
  current3_a?: number | null;
  power1_w?: number | null;
  power2_w?: number | null;
  power3_w?: number | null;
  press1_bar?: number | null;
  press2_bar?: number | null;
  temp1_raw_c?: number | null;
  temp2_raw_c?: number | null;
  temp3_raw_c?: number | null;
  temp4_raw_c?: number | null;
  temp5_raw_c?: number | null;
  temp6_raw_c?: number | null;
  current1_raw_a?: number | null;
  current2_raw_a?: number | null;
  current3_raw_a?: number | null;
  power1_raw_w?: number | null;
  power2_raw_w?: number | null;
  power3_raw_w?: number | null;
  press1_raw_bar?: number | null;
  press2_raw_bar?: number | null;
}

const READINGS_SELECT =
  'id, datalogger_id, created_at, temp1_c, temp2_c, temp3_c, temp4_c, temp5_c, temp6_c, current1_a, current2_a, current3_a, power1_w, power2_w, power3_w, press1_bar, press2_bar, temp1_raw_c, temp2_raw_c, temp3_raw_c, temp4_raw_c, temp5_raw_c, temp6_raw_c, current1_raw_a, current2_raw_a, current3_raw_a, power1_raw_w, power2_raw_w, power3_raw_w, press1_raw_bar, press2_raw_bar';

const TEMP_FIELDS: (keyof DataloggerReadingRow)[] = [
  'temp1_c', 'temp2_c', 'temp3_c', 'temp4_c', 'temp5_c', 'temp6_c',
];
const POWER_FIELDS: (keyof DataloggerReadingRow)[] = ['power1_w', 'power2_w', 'power3_w'];
const PRESS_FIELDS: (keyof DataloggerReadingRow)[] = ['press1_bar', 'press2_bar'];

const LS_PREFIX = 'ar-datalogger-chart-series-v1:';
const MAX_FETCH = 8000;
const MAX_DRAW_POINTS = 1600;

@Component({
  selector: 'app-datalogger-chart',
  templateUrl: './datalogger-chart.component.html',
  styleUrls: ['./datalogger-chart.component.scss'],
})
export class DataloggerChartComponent implements OnInit, OnDestroy {
  readonly environment = environment;

  dataloggerId: string | null = null;
  dataloggerName = 'Datalogger';
  loading = false;
  error = '';

  filterFrom = '';
  filterTo = '';

  showTemps = [true, true, true, true, true, true];
  showPowers = [true, true, true];
  showPress = [true, true];
  showHistogram = true;

  tempPaths: string[] = ['', '', '', '', '', ''];
  tempTrendSegs: ChartTrendSegment[][] = [[], [], [], [], [], []];
  powerPaths: string[] = ['', '', ''];
  pressPaths: string[] = ['', ''];
  tempMin = -30;
  tempMax = 10;
  powerMin = 0;
  powerMax = 100;
  pressMin = 0;
  pressMax = 10;

  private readonly chartStyleStorageKey = 'ar_datalogger_chart_style_v1';
  chartStylePreset: ChartStylePreset = 'area';
  readonly chartStyleOptions: { value: ChartStylePreset; label: string }[] = [
    { value: 'area', label: 'Área (relleno suave)' },
    { value: 'line', label: 'Solo líneas' },
    { value: 'minimal', label: 'Minimal (limpio)' },
    { value: 'technical', label: 'Técnico (rejilla)' },
    { value: 'trend', label: 'Tendencia (color por subida/bajada)' },
  ];
  chartTallLayout = false;

  readings: DataloggerReadingRow[] = [];
  displayPoints: DataloggerReadingRow[] = [];
  private dataloggerParams: DataloggerFormModel | null = null;

  /** SVG viewBox 0 0 100 56 — temperaturas */
  readonly tempPlot = { x0: 4, x1: 99, y0: 4, y1: 52 };
  tempPath = '';
  timeLabels: { x: number; text: string }[] = [];

  /** Histograma temperaturas en rango visible */
  histBars: { x: number; h: number; w: number }[] = [];
  histMaxCount = 1;

  /** Refleja si esta vista está en pantalla completa del navegador. */
  isFullscreenUi = false;
  chartZoomLo = 0;
  chartZoomHi = 1;
  cursorActive = false;
  cursorX = 0;
  cursorY = 0;
  cursorLabelTime = '';
  cursorLabelTemp = '';
  private zoomStartMs = 0;
  private zoomSpanMs = 1;
  private zoomedPoints: DataloggerReadingRow[] = [];
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

  pdfExporting = false;

  @ViewChild('fullscreenRoot', { static: true })
  fullscreenRoot!: ElementRef<HTMLElement>;

  @ViewChild('chartStage', { static: false })
  chartStage?: ElementRef<HTMLElement>;

  @ViewChild('chartPdfCapture') chartPdfCapture?: ElementRef<HTMLElement>;

  private sub?: Subscription;
  private realtimeChannel: RealtimeChannel | null = null;
  private readonly onFullscreenChange = (): void => {
    this.zone.run(() => {
      this.isFullscreenUi = isCurrentFullscreen(this.fullscreenRoot?.nativeElement ?? null);
    });
  };

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService,
    private readonly zone: NgZone
  ) {}

  ngOnInit(): void {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange as EventListener);
    this.sub = this.route.queryParamMap.subscribe((q) => {
      const id = q.get('dataloggerId');
      this.dataloggerId = id && id.length > 10 ? id : null;
      this.initDefaultRange();
      this.loadSeriesPrefs();
      this.loadChartStylePreset();
      if (this.dataloggerId) {
        void this.loadAll();
      } else {
        this.error = 'Falta dataloggerId en la URL (ej. ?dataloggerId=…).';
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.teardownRealtime();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange as EventListener);
    const el = this.fullscreenRoot?.nativeElement;
    if (el && isCurrentFullscreen(el)) {
      void exitFullscreenBestEffort();
    }
  }

  @HostListener('document:mouseup')
  onDocMouseUp(): void {
    this.draggingPan = false;
  }

  @HostListener('document:mousemove', ['$event'])
  onDocMouseMove(ev: MouseEvent): void {
    if (!this.draggingPan) return;
    const el =
      this.chartStage?.nativeElement ??
      (this.fullscreenRoot?.nativeElement?.querySelector('.pr5-svg-wrap:not(.pr5-svg-wrap--hist):not(.pr5-svg-wrap--states)') as
        | HTMLElement
        | null);
    if (!el) return;
    const w = Math.max(1, el.getBoundingClientRect().width);
    const dxNorm = (ev.clientX - this.dragStartClientX) / w;
    chartZoomHostPanFromDrag(this, dxNorm, this.dragStartLo, this.dragStartHi);
  }

  async toggleFullscreen(): Promise<void> {
    const el = this.fullscreenRoot?.nativeElement;
    if (!el) return;
    try {
      if (isCurrentFullscreen(el)) {
        await exitFullscreenBestEffort();
      } else {
        await requestFullscreenBestEffort(el);
      }
    } catch {
      /* algunos navegadores bloquean sin gesto del usuario */
    }
  }

  private lsKey(): string {
    return `${LS_PREFIX}${this.dataloggerId ?? 'none'}`;
  }

  private loadSeriesPrefs(): void {
    if (!this.dataloggerId) return;
    try {
      const raw = localStorage.getItem(this.lsKey());
      if (!raw) return;
      const o = JSON.parse(raw) as Record<string, unknown>;
      const ba = (k: string, def: boolean[]) => {
        const v = o[k];
        return Array.isArray(v) && v.length === def.length
          ? (v as boolean[]).map((b, i) => (typeof b === 'boolean' ? b : def[i]))
          : def.slice();
      };
      this.showTemps = ba('t', [true, true, true, true, true, true]);
      this.showPowers = ba('pw', [true, true, true]);
      this.showPress = ba('pr', [true, true]);
      this.showHistogram = typeof o['h'] === 'boolean' ? (o['h'] as boolean) : true;
    } catch {
      /* ignore */
    }
  }

  persistSeriesPrefs(): void {
    if (!this.dataloggerId) return;
    const o = { t: this.showTemps, pw: this.showPowers, pr: this.showPress, h: this.showHistogram };
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
    if (!this.dataloggerId || !environment.deviceCloudSync || !isSupabaseConfigured()) {
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
      const { data: meta, error: eMeta } = await this.auth.client
        .from('datalogger_controllers')
        .select('name, params')
        .eq('id', this.dataloggerId)
        .maybeSingle();
      if (eMeta) {
        this.error = eMeta.message;
        return;
      }
      const metaRow = meta as { name?: string; params?: unknown } | null;
      this.dataloggerName = metaRow?.name?.trim() || 'Datalogger';
      this.dataloggerParams = mergeDataloggerParams(metaRow?.params ?? null);

      const fromD = this.parseLocalInput(this.filterFrom);
      const toD = this.parseLocalInput(this.filterTo);
      if (!fromD || !toD || fromD >= toD) {
        this.error = 'Revisá el rango de fechas (desde < hasta).';
        return;
      }
      const fromIso = fromD.toISOString();
      const toIso = toD.toISOString();

      const { data: rows, error: eRows } = await this.auth.client
        .from('datalogger_readings')
        .select(READINGS_SELECT)
        .eq('datalogger_id', this.dataloggerId)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: true })
        .limit(MAX_FETCH);

      if (eRows) {
        if (eRows.message?.includes('Could not find') || eRows.code === '42P01') {
          this.error =
            'Falta historial en datalogger_readings. Ejecutá en Supabase el SQL `059_datalogger_readings.sql` y redeployá `ingest-reading`.';
        } else {
          this.error = eRows.message;
        }
        this.readings = [];
        this.displayPoints = [];
        return;
      }
      this.readings = ((rows ?? []) as DataloggerReadingRow[]).map((r) =>
        this.correctReadingRow(r)
      );
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

  private teardownRealtime(): void {
    if (this.realtimeChannel != null) {
      void this.auth.client.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }

  private setupRealtime(): void {
    this.teardownRealtime();
    const id = this.dataloggerId;
    if (!id || !environment.deviceCloudSync || !isSupabaseConfigured()) return;
    this.realtimeChannel = this.auth.client
      .channel(`datalogger-chart:${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'datalogger_readings',
          filter: `datalogger_id=eq.${id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          this.zone.run(() => this.appendRealtimeReading(row));
        }
      )
      .subscribe();
  }

  private appendRealtimeReading(row: Record<string, unknown>): void {
    const id = typeof row['id'] === 'number' ? row['id'] : Number(row['id']);
    const createdAt = typeof row['created_at'] === 'string' ? row['created_at'] : '';
    const temp1 = typeof row['temp1_c'] === 'number' ? row['temp1_c'] : null;
    if (!Number.isFinite(id) || !createdAt) return;
    if (temp1 == null && row['press1_bar'] == null && row['power1_w'] == null) return;

    const fromD = this.parseLocalInput(this.filterFrom);
    const toD = this.parseLocalInput(this.filterTo);
    const at = new Date(createdAt).getTime();
    if (fromD && toD && (at < fromD.getTime() || at > toD.getTime())) return;

    if (this.readings.some((r) => r.id === id)) return;

    const reading = this.correctReadingRow(row as unknown as DataloggerReadingRow);
    reading.id = id;
    reading.datalogger_id = this.dataloggerId!;
    reading.created_at = createdAt;

    this.readings = [...this.readings, reading];
    if (this.readings.length > MAX_FETCH) {
      this.readings = this.readings.slice(this.readings.length - MAX_FETCH);
    }
    this.downsample();
    this.rebuildChartGeometry();
  }

  private correctReadingRow(row: DataloggerReadingRow): DataloggerReadingRow {
    if (!this.dataloggerParams) return row;
    const corrected = correctDataloggerReadingRow(
      row as unknown as Record<string, unknown>,
      this.dataloggerParams
    );
    const out = { ...row };
    for (const [k, v] of Object.entries(corrected)) {
      if (v != null && Number.isFinite(v)) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  }

  private downsample(): void {
    const src = this.readings;
    if (src.length <= MAX_DRAW_POINTS) {
      this.displayPoints = src.slice();
      return;
    }
    const step = Math.ceil(src.length / MAX_DRAW_POINTS);
    const out: DataloggerReadingRow[] = [];
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

  toggleChartTallLayout(): void {
    this.chartTallLayout = !this.chartTallLayout;
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
    chartZoomHostWheel(this, ev, this.chartStage?.nativeElement, this.displayPoints.length > 0);
  }

  async downloadChartPdf(): Promise<void> {
    if (this.pdfExporting || !this.readings.length) return;
    this.pdfExporting = true;
    this.cursorActive = false;
    try {
      await downloadDeviceChartPdf({
        title: 'Historial Datalogger',
        deviceName: this.dataloggerName,
        rangeLabel: this.pdfRangeLabel(),
        styleLabel: chartStyleLabel(this.chartStyleOptions, this.chartStylePreset),
        rows: this.readings as unknown as Record<string, unknown>[],
        columns: [
          { header: 'Fecha', cell: (r) => pdfCellDate(r['created_at']) },
          { header: 'T1 °C', cell: (r) => pdfCellNum(r['temp1_c'], 2) },
          { header: 'T2 °C', cell: (r) => pdfCellNum(r['temp2_c'], 2) },
          { header: 'I1 A', cell: (r) => pdfCellNum(r['current1_a'], 2) },
          { header: 'P1 W', cell: (r) => pdfCellNum(r['power1_w'], 1) },
          { header: 'Pr1 bar', cell: (r) => pdfCellNum(r['press1_bar'], 2) },
          { header: 'Pr2 bar', cell: (r) => pdfCellNum(r['press2_bar'], 2) },
        ],
        fileSlug: this.dataloggerName || 'datalogger',
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
      this.tempPaths = ['', '', '', '', '', ''];
      this.tempTrendSegs = [[], [], [], [], [], []];
      this.powerPaths = ['', '', ''];
      this.pressPaths = ['', ''];
      this.timeLabels = [];
      this.histBars = [];
      this.histMaxCount = 1;
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
      return this.tempPlot.x0 + ((tx - t0) / span) * (this.tempPlot.x1 - this.tempPlot.x0);
    };

    let minT = Infinity;
    let maxT = -Infinity;
    for (const p of pts) {
      for (let i = 0; i < TEMP_FIELDS.length; i++) {
        if (!this.showTemps[i]) continue;
        const v = p[TEMP_FIELDS[i]] as number | null | undefined;
        if (v != null && Number.isFinite(v)) {
          minT = Math.min(minT, v);
          maxT = Math.max(maxT, v);
        }
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
    const yAt = (c: number) =>
      this.tempPlot.y1 - ((c - this.tempMin) / tr) * (this.tempPlot.y1 - this.tempPlot.y0);

    const pathForNum = (
      getter: (p: DataloggerReadingRow) => number | null | undefined,
      yScale: (v: number) => number
    ) => {
      let d = '';
      let first = true;
      for (const p of pts) {
        const v = getter(p);
        if (v == null || Number.isNaN(v)) continue;
        const x = xAt(p.created_at);
        const y = yScale(v);
        d += first ? `M${x.toFixed(2)},${y.toFixed(2)}` : ` L${x.toFixed(2)},${y.toFixed(2)}`;
        first = false;
      }
      return d;
    };

    this.tempPaths = TEMP_FIELDS.map((k, i) =>
      this.showTemps[i] ? pathForNum((p) => p[k] as number | null, yAt) : ''
    );
    const tempEps = Math.max((this.tempMax - this.tempMin) * 0.002, 0.02);
    this.tempTrendSegs = TEMP_FIELDS.map((k, i) => {
      if (!this.showTemps[i] || this.chartStylePreset !== 'trend') return [];
      return buildChartTrendSegments(
        pts.map((p) => ({ x: xAt(p.created_at), y: p[k] as number | null })),
        tempEps
      );
    });

    let minP = Infinity;
    let maxP = -Infinity;
    for (const p of pts) {
      for (let i = 0; i < POWER_FIELDS.length; i++) {
        if (!this.showPowers[i]) continue;
        const v = (p[POWER_FIELDS[i]] ?? p[`current${i + 1}_a` as keyof DataloggerReadingRow]) as number | null;
        if (v != null && Number.isFinite(v)) {
          minP = Math.min(minP, v);
          maxP = Math.max(maxP, v);
        }
      }
    }
    if (!Number.isFinite(minP)) {
      minP = 0;
      maxP = 100;
    }
    const padP = Math.max((maxP - minP) * 0.08, 1);
    this.powerMin = minP - padP;
    this.powerMax = maxP + padP;
    const pr = this.powerMax - this.powerMin || 1;
    const yPow = (v: number) => this.tempPlot.y1 - ((v - this.powerMin) / pr) * (this.tempPlot.y1 - this.tempPlot.y0);
    this.powerPaths = POWER_FIELDS.map((k, i) =>
      this.showPowers[i] ? pathForNum((p) => p[k] as number | null, yPow) : ''
    );

    let minPr = Infinity;
    let maxPr = -Infinity;
    for (const p of pts) {
      for (let i = 0; i < PRESS_FIELDS.length; i++) {
        if (!this.showPress[i]) continue;
        const v = p[PRESS_FIELDS[i]] as number | null;
        if (v != null && Number.isFinite(v)) {
          minPr = Math.min(minPr, v);
          maxPr = Math.max(maxPr, v);
        }
      }
    }
    if (!Number.isFinite(minPr)) {
      minPr = 0;
      maxPr = 10;
    }
    const padPr = Math.max((maxPr - minPr) * 0.08, 0.1);
    this.pressMin = minPr - padPr;
    this.pressMax = maxPr + padPr;
    const prSpan = this.pressMax - this.pressMin || 1;
    const yPress = (v: number) =>
      this.tempPlot.y1 - ((v - this.pressMin) / prSpan) * (this.tempPlot.y1 - this.tempPlot.y0);
    this.pressPaths = PRESS_FIELDS.map((k, i) =>
      this.showPress[i] ? pathForNum((p) => p[k] as number | null, yPress) : ''
    );

    this.tempPath = this.tempPaths[0] ?? '';

    this.timeLabels = [
      { x: this.tempPlot.x0, text: this.fmtShort(pts[0].created_at) },
      { x: (this.tempPlot.x0 + this.tempPlot.x1) / 2, text: this.fmtShort(new Date((t0 + t1) / 2).toISOString()) },
      { x: this.tempPlot.x1, text: this.fmtShort(pts[pts.length - 1].created_at) },
    ];

    this.buildHistogram(pts);
    if (this.cursorActive) this.updateCursorForX(this.cursorX);
  }

  private fmtShort(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  private buildHistogram(pts: DataloggerReadingRow[]): void {
    this.histBars = [];
    this.histMaxCount = 1;
    if (!this.showHistogram || pts.length < 2) return;

    const vals: number[] = [];
    for (const p of pts) {
      for (let i = 0; i < TEMP_FIELDS.length; i++) {
        if (!this.showTemps[i]) continue;
        const v = p[TEMP_FIELDS[i]] as number | null;
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
    }
    if (vals.length < 2) return;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < 0.2) {
      lo -= 0.5;
      hi += 0.5;
    }
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

  toggleTemp(i: number): void {
    this.showTemps[i] = !this.showTemps[i];
    this.persistSeriesPrefs();
  }

  togglePower(i: number): void {
    this.showPowers[i] = !this.showPowers[i];
    this.persistSeriesPrefs();
  }

  togglePress(i: number): void {
    this.showPress[i] = !this.showPress[i];
    this.persistSeriesPrefs();
  }

  backToApp(): void {
    void this.router.navigate(['/dispositivos']);
  }

  rectW(r: { x0: number; x1: number }): number {
    return Math.max(0.08, r.x1 - r.x0);
  }

  barDisplayHeight(ratio: number): number {
    return Math.max(0.6, ratio * 36);
  }

  startTempPan(ev: MouseEvent): void {
    if (!this.zoomedPoints.length || !this.chartZoomIsActive) return;
    this.draggingPan = true;
    this.dragStartClientX = ev.clientX;
    this.dragStartLo = this.chartZoomLo;
    this.dragStartHi = this.chartZoomHi;
    ev.preventDefault();
  }

  onTempTouchStart(ev: TouchEvent): void {
    if (!this.zoomedPoints.length) return;
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
      this.touchStartCenterNorm = Math.max(0, Math.min(1, ((t0.clientX + t1.clientX) * 0.5 - r.left) / Math.max(1, r.width)));
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
    const r = chartEl.getBoundingClientRect();
    if (r.width <= 1) return;

    if (this.touchMode === 'pinch' && ev.touches.length >= 2) {
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      const dist = Math.max(6, Math.abs(t1.clientX - t0.clientX));
      const centerNorm = Math.max(0, Math.min(1, ((t0.clientX + t1.clientX) * 0.5 - r.left) / r.width));
      this.chartZoomLo = this.touchStartZoomLo;
      this.chartZoomHi = this.touchStartZoomHi;
      chartZoomHostPinch(this, this.touchStartDist / dist, centerNorm);
      ev.preventDefault();
      return;
    }

    if (this.touchMode === 'pan' && ev.touches.length === 1) {
      const dxNorm = (ev.touches[0].clientX - this.dragStartClientX) / r.width;
      chartZoomHostPanFromDrag(this, dxNorm, this.dragStartLo, this.dragStartHi);
      ev.preventDefault();
    }
  }

  onTempTouchEnd(): void {
    this.touchMode = 'none';
  }

  onTempMouseLeave(): void {
    this.cursorActive = false;
  }

  onTempMouseMove(ev: MouseEvent): void {
    const svg = ev.currentTarget as SVGElement | null;
    if (!svg || !this.zoomedPoints.length) return;
    const r = svg.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;
    const x = ((ev.clientX - r.left) / r.width) * 100;
    this.cursorActive = true;
    this.updateCursorForX(x);
  }

  private updateCursorForX(x: number): void {
    if (!this.zoomedPoints.length) {
      this.cursorActive = false;
      return;
    }
    const cx = Math.max(this.tempPlot.x0, Math.min(this.tempPlot.x1, x));
    this.cursorX = cx;
    const ratio = (cx - this.tempPlot.x0) / Math.max(0.0001, this.tempPlot.x1 - this.tempPlot.x0);
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
      this.tempPlot.y1 - ((v - this.tempMin) / tr) * (this.tempPlot.y1 - this.tempPlot.y0);
    this.cursorY = best.temp1_c != null && Number.isFinite(best.temp1_c) ? yAt(best.temp1_c) : this.tempPlot.y1;
    this.cursorLabelTemp =
      best.temp1_c != null && Number.isFinite(best.temp1_c) ? `${best.temp1_c.toFixed(2)} °C (T1)` : '—';
    this.cursorLabelTime = new Date(best.created_at).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}
