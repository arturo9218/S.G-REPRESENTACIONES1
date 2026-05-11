import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { environment } from '../../environments/environment';
import { isSupabaseConfigured } from '../core/supabase-config';
import { mergePr500Params, PR500_PSI_PER_BAR, pr500BarToPsi } from '../pr500/pr500-params.defaults';
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
  /** Modo tendencia: tramos de presión coloreados + puntos. */
  pressureTrendSegs: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> = [];
  pressureTrendDots: Array<{ cx: number; cy: number }> = [];
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
  /** Área útil del SVG (viewBox 0–100). `x1` se estrecha si hay eje de temperatura. */
  plot = { x0: 19, x1: 99, y0: 7, y1: 83 };
  /** Marcas del eje X: posición, texto y segmento de marca bajo el gráfico. */
  timeLabels: { x: number; y: number; text: string; tickY0: number; tickY1: number }[] = [];
  yAxisTicks: { y: number; label: string; markX0: number; markX1: number }[] = [];
  yGridLines: string[] = [];
  /** Rejilla vertical en marcas de tiempo (trazos suaves). */
  xGridLines: string[] = [];
  activityRects: { lane: number; x0: number; x1: number; on: boolean }[] = [];
  readonly activityLabels = ['C1', 'C2', 'C3', 'Alarma'];
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
  chartFullscreen = false;
  /** Zoom horizontal fraccional sobre el rango cargado (0..1). */
  chartZoomLo = 0;
  chartZoomHi = 1;

  private sub?: Subscription;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService
  ) {}

  ngOnInit(): void {
    this.loadChartStylePreset();
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
    const span = this.dragStartHi - this.dragStartLo;
    let lo = this.dragStartLo - dxNorm * span;
    let hi = this.dragStartHi - dxNorm * span;
    if (lo < 0) {
      hi -= lo;
      lo = 0;
    }
    if (hi > 1) {
      lo -= hi - 1;
      hi = 1;
    }
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
    if (hi - lo < 0.05) return;
    this.chartZoomLo = lo;
    this.chartZoomHi = hi;
    this.rebuildChartGeometry();
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onChartFullscreenChange(): void {
    const el = this.chartStage?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fs = document.fullscreenElement ?? doc.webkitFullscreenElement;
    this.chartFullscreen = !!el && fs === el;
  }

  toggleChartFullscreen(): void {
    const el = this.chartStage?.nativeElement;
    if (!el) return;
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const active = document.fullscreenElement ?? doc.webkitFullscreenElement;
    const anyEl = el as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (!active) {
      const req = el.requestFullscreen?.bind(el) ?? anyEl.webkitRequestFullscreen?.bind(el);
      void req?.();
    } else {
      const d = document as Document & { webkitExitFullscreen?: () => Promise<void> };
      void (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    }
  }

  backToApp(): void {
    void this.router.navigate(['/dashboard']);
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
    const el = this.chartStage?.nativeElement;
    if (!el || !this.zoomedPoints.length) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 1) return;
    const x = ((clientX - r.left) / r.width) * 100;
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
        .select('*')
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
    return this.chartZoomLo > 0.0001 || this.chartZoomHi < 0.9999;
  }

  chartZoomIn(): void {
    this.adjustZoom(0.72);
  }

  chartZoomOut(): void {
    this.adjustZoom(1 / 0.72);
  }

  resetChartZoom(): void {
    this.chartZoomLo = 0;
    this.chartZoomHi = 1;
    this.cursorActive = false;
    this.rebuildChartGeometry();
  }

  private adjustZoom(factor: number): void {
    const span = this.chartZoomHi - this.chartZoomLo;
    const center = this.chartZoomLo + span / 2;
    let next = span * factor;
    next = Math.max(0.05, Math.min(1, next));
    let lo = center - next / 2;
    let hi = center + next / 2;
    if (lo < 0) {
      hi -= lo;
      lo = 0;
    }
    if (hi > 1) {
      lo -= hi - 1;
      hi = 1;
    }
    this.chartZoomLo = Math.max(0, lo);
    this.chartZoomHi = Math.min(1, hi);
    if (this.chartZoomHi - this.chartZoomLo < 0.05) {
      this.chartZoomHi = Math.min(1, this.chartZoomLo + 0.05);
    }
    this.rebuildChartGeometry();
  }

  private getZoomedPoints(src: Pr500ReadingRow[]): Pr500ReadingRow[] {
    if (!src.length || !this.chartZoomIsActive) return src;
    const n = src.length;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(this.chartZoomLo * (n - 1))));
    const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil(this.chartZoomHi * (n - 1)) + 1));
    const out = src.slice(i0, i1);
    return out.length >= 2 ? out : src.slice(Math.max(0, i0 - 1), Math.min(n, i1 + 1));
  }

  /** Última lectura del rango cargado (para cabecera del gráfico). */
  get latestReading(): Pr500ReadingRow | null {
    return this.readings.length ? this.readings[this.readings.length - 1] : null;
  }

  formatYAxisValue(v: number): string {
    if (this.pressureDisplayPsi) return v.toFixed(1);
    return v.toFixed(2);
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

  private rebuildChartGeometry(): void {
    const pts = this.getZoomedPoints(this.displayPoints);
    this.zoomedPoints = pts;
    if (pts.length === 0) {
      this.pressurePath = '';
      this.pressureAreaPath = '';
      this.tempPath = '';
      this.superheatPath = '';
      this.hasTempAxis = false;
      this.tempAxisTicks = [];
      this.plot.x1 = 99;
      this.timeLabels = [];
      this.yAxisTicks = [];
      this.yGridLines = [];
      this.xGridLines = [];
      this.activityRects = [];
      this.pressureTrendSegs = [];
      this.pressureTrendDots = [];
      this.cursorActive = false;
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
    this.plot.x1 = this.hasTempAxis ? 86.5 : 99;
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
    this.pressureTrendDots = [];
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
      for (let i = 0; i < pts.length; i++) {
        const v = toY(pts[i].pressure_bar);
        if (!Number.isFinite(v)) continue;
        this.pressureTrendDots.push({ cx: xAt(pts[i].created_at), cy: yAtVal(v) });
      }
    }

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

    const stepMs = Pr500ChartComponent.pickTimeStepMs(span, 6);
    let curT = Math.floor(t0 / stepMs) * stepMs;
    while (curT < t0 - 0.5) curT += stepMs;
    const epochList: number[] = [];
    while (curT <= t1 + stepMs * 0.01) {
      if (curT >= t0 && curT <= t1) epochList.push(curT);
      curT += stepMs;
      if (epochList.length > 18) break;
    }
    const mergedEpochs = this.mergeTimeEndpoints(epochList, t0, t1, span);
    const tLabs: { x: number; y: number; text: string; tickY0: number; tickY1: number }[] = [];
    const xGrids: string[] = [];
    let prevX = -Infinity;
    /** Espacio mínimo en unidades del viewBox entre centros de etiquetas (evita solapamiento al estirar el SVG). */
    const minLabelDx = Math.max(11, plotW / 6.5);
    for (const tm of mergedEpochs) {
      const x = xAt(new Date(tm).toISOString());
      if (x < x0 - 0.02 || x > x1 + 0.02) continue;
      if (x - prevX < minLabelDx) continue;
      prevX = x;
      const labelY = y1 + 5.8;
      tLabs.push({
        x,
        y: labelY,
        text: this.formatTimeAxisLabel(tm, span),
        tickY0: y1,
        tickY1: y1 + 2.6,
      });
      if (tLabs.length <= 12) {
        xGrids.push(`M${x.toFixed(2)},${y0.toFixed(2)}L${x.toFixed(2)},${y1.toFixed(2)}`);
      }
    }
    this.timeLabels = tLabs;
    this.xGridLines = xGrids;
    this.activityRects = this.buildActivityRects(pts, xAt);
    if (this.cursorActive) {
      this.updateCursorForX(this.cursorX);
    }
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

  onChartWheel(ev: WheelEvent): void {
    const el = this.chartStage?.nativeElement;
    if (!el || !this.zoomedPoints.length) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 1) return;
    const xNorm = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const span = this.chartZoomHi - this.chartZoomLo;
    const center = this.chartZoomLo + xNorm * span;
    const factor = ev.deltaY < 0 ? 0.82 : 1 / 0.82;
    let next = span * factor;
    next = Math.max(0.05, Math.min(1, next));
    let lo = center - next * xNorm;
    let hi = lo + next;
    if (lo < 0) {
      hi -= lo;
      lo = 0;
    }
    if (hi > 1) {
      lo -= hi - 1;
      hi = 1;
    }
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
    if (hi - lo < 0.05) return;
    this.chartZoomLo = lo;
    this.chartZoomHi = hi;
    this.rebuildChartGeometry();
    ev.preventDefault();
  }

  onChartTouchStart(ev: TouchEvent): void {
    if (!this.zoomedPoints.length) return;
    this.noteTouchTapStart(ev);
    if (ev.touches.length >= 2) {
      const el = this.chartStage?.nativeElement;
      if (!el) return;
      const r = el.getBoundingClientRect();
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
      let next = this.touchStartSpan * (this.touchStartDist / dist);
      next = Math.max(0.05, Math.min(1, next));
      const span0 = this.touchStartZoomHi - this.touchStartZoomLo;
      const center = this.touchStartZoomLo + this.touchStartCenterNorm * span0;
      let lo = center - next * this.touchStartCenterNorm;
      let hi = lo + next;
      if (lo < 0) {
        hi -= lo;
        lo = 0;
      }
      if (hi > 1) {
        lo -= hi - 1;
        hi = 1;
      }
      this.chartZoomLo = Math.max(0, lo);
      this.chartZoomHi = Math.min(1, hi);
      this.rebuildChartGeometry();
      ev.preventDefault();
      return;
    }

    if (this.touchMode === 'pan' && ev.touches.length === 1) {
      const t = ev.touches[0];
      const dxNorm = (t.clientX - this.dragStartClientX) / r.width;
      const span = this.dragStartHi - this.dragStartLo;
      let lo = this.dragStartLo - dxNorm * span;
      let hi = this.dragStartHi - dxNorm * span;
      if (lo < 0) {
        hi -= lo;
        lo = 0;
      }
      if (hi > 1) {
        lo -= hi - 1;
        hi = 1;
      }
      lo = Math.max(0, lo);
      hi = Math.min(1, hi);
      if (hi - lo < 0.05) return;
      if (Math.abs(dxNorm) > 0.002) this.touchPanDidNudge = true;
      this.chartZoomLo = lo;
      this.chartZoomHi = hi;
      this.rebuildChartGeometry();
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
        bits.push(`SH ${best.superheat_c.toFixed(1)} °C${warn}`);
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
      tbits.push(`SH ${r.superheat_c.toFixed(1)} °C`);
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
    return `SH ${L.superheat_c.toFixed(1)} °C${warn}`;
  }

  stateRectW(r: { x0: number; x1: number }): number {
    return Math.max(0.08, r.x1 - r.x0);
  }
}
