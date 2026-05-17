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
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
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

function getFullscreenElement(): Element | null {
  const d = document as Document & {
    webkitFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
  };
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? d.mozFullScreenElement ?? null;
}

function isCurrentFullscreen(host: HTMLElement | null): boolean {
  if (!host) return false;
  return getFullscreenElement() === host;
}

async function requestFullscreenBestEffort(el: HTMLElement): Promise<void> {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  if (typeof anyEl.requestFullscreen === 'function') {
    await anyEl.requestFullscreen();
  } else if (typeof anyEl.webkitRequestFullscreen === 'function') {
    anyEl.webkitRequestFullscreen();
  }
}

async function exitFullscreenBestEffort(): Promise<void> {
  const d = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
  if (typeof document.exitFullscreen === 'function') {
    await document.exitFullscreen();
  } else if (typeof d.webkitExitFullscreen === 'function') {
    d.webkitExitFullscreen();
  }
}

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

  readings: CombistatoReadingRow[] = [];
  displayPoints: CombistatoReadingRow[] = [];

  /** SVG viewBox 0 0 100 56 — temperaturas */
  readonly tempPlot = { x0: 4, x1: 99, y0: 4, y1: 52 };
  tempPath1 = '';
  tempPath2 = '';
  tempMin = -30;
  tempMax = 10;
  timeLabels: { x: number; text: string }[] = [];

  /** Franjas actividad: [ { lane, x0, x1, on } ] en coords 0–100 */
  activityRects: { lane: number; x0: number; x1: number; on: boolean }[] = [];

  /** Histograma temp1+temp2 en rango visible */
  histBars: { x: number; h: number; w: number }[] = [];
  histMaxCount = 1;

  /** Refleja si esta vista está en pantalla completa del navegador. */
  isFullscreenUi = false;
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

  @ViewChild('fullscreenRoot', { static: true })
  fullscreenRoot!: ElementRef<HTMLElement>;

  private sub?: Subscription;
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
      const id = q.get('combistatoId');
      this.combistatoId = id && id.length > 10 ? id : null;
      this.initDefaultRange();
      this.loadSeriesPrefs();
      if (this.combistatoId) {
        void this.loadAll();
      } else {
        this.error = 'Falta combistatoId en la URL (ej. ?combistatoId=…).';
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
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
    const el = this.fullscreenRoot?.nativeElement?.querySelector('.cb-chart-wrap') as HTMLElement | null;
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
    if (hi - lo < 0.06) return;
    this.chartZoomLo = lo;
    this.chartZoomHi = hi;
    this.rebuildChartGeometry();
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
    try {
      const session = await this.auth.getSession();
      if (!session?.user) {
        void this.router.navigate(['/login']);
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
    next = Math.max(0.06, Math.min(1, next));
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
    if (this.chartZoomHi - this.chartZoomLo < 0.06) {
      this.chartZoomHi = Math.min(1, this.chartZoomLo + 0.06);
    }
    this.rebuildChartGeometry();
  }

  private getZoomedPoints(src: CombistatoReadingRow[]): CombistatoReadingRow[] {
    if (!src.length || !this.chartZoomIsActive) return src;
    const n = src.length;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(this.chartZoomLo * (n - 1))));
    const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil(this.chartZoomHi * (n - 1)) + 1));
    const out = src.slice(i0, i1);
    return out.length >= 2 ? out : src.slice(Math.max(0, i0 - 1), Math.min(n, i1 + 1));
  }

  private rebuildChartGeometry(): void {
    const pts = this.getZoomedPoints(this.displayPoints);
    this.zoomedPoints = pts;
    if (pts.length === 0) {
      this.tempPath1 = '';
      this.tempPath2 = '';
      this.timeLabels = [];
      this.activityRects = [];
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
    const yAt = (c: number) =>
      this.tempPlot.y1 - ((c - this.tempMin) / tr) * (this.tempPlot.y1 - this.tempPlot.y0);

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

    this.timeLabels = [
      { x: this.tempPlot.x0, text: this.fmtShort(pts[0].created_at) },
      { x: (this.tempPlot.x0 + this.tempPlot.x1) / 2, text: this.fmtShort(new Date((t0 + t1) / 2).toISOString()) },
      { x: this.tempPlot.x1, text: this.fmtShort(pts[pts.length - 1].created_at) },
    ];

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

  private buildHistogram(pts: CombistatoReadingRow[]): void {
    this.histBars = [];
    this.histMaxCount = 1;
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

  activityLaneY(lane: number): number {
    return 10 + lane * 20;
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
    const chartEl = this.fullscreenRoot?.nativeElement?.querySelector('.cb-svg--temp') as SVGElement | null;
    if (!chartEl) return;
    const r = chartEl.getBoundingClientRect();
    if (ev.touches.length >= 2) {
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      this.touchMode = 'pinch';
      this.touchStartDist = Math.abs(t1.clientX - t0.clientX);
      this.touchStartSpan = this.chartZoomHi - this.chartZoomLo;
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
    const chartEl = this.fullscreenRoot?.nativeElement?.querySelector('.cb-svg--temp') as SVGElement | null;
    if (!chartEl || !this.zoomedPoints.length) return;
    const r = chartEl.getBoundingClientRect();
    if (r.width <= 1) return;

    if (this.touchMode === 'pinch' && ev.touches.length >= 2) {
      const t0 = ev.touches[0];
      const t1 = ev.touches[1];
      const dist = Math.max(6, Math.abs(t1.clientX - t0.clientX));
      const centerNorm = Math.max(0, Math.min(1, ((t0.clientX + t1.clientX) * 0.5 - r.left) / r.width));
      let next = this.touchStartSpan * (this.touchStartDist / dist);
      next = Math.max(0.06, Math.min(1, next));
      let lo = centerNorm - next * centerNorm;
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
      const dxNorm = (ev.touches[0].clientX - this.dragStartClientX) / r.width;
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
      if (hi - lo < 0.06) return;
      this.chartZoomLo = lo;
      this.chartZoomHi = hi;
      this.rebuildChartGeometry();
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
    this.cursorY1 = yAt(best.temp1_c);
    this.cursorY2 = best.temp2_c != null && Number.isFinite(best.temp2_c) ? yAt(best.temp2_c) : this.cursorY1;
    this.cursorLabelTemp1 = Number.isFinite(best.temp1_c) ? `${best.temp1_c.toFixed(2)} °C` : '—';
    this.cursorLabelTemp2 = best.temp2_c != null && Number.isFinite(best.temp2_c) ? `${best.temp2_c.toFixed(2)} °C` : '—';
    this.cursorLabelTime = new Date(best.created_at).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}
