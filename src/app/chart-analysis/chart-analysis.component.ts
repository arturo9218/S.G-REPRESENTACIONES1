import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { DeviceStoreService } from '../core/device-store.service';
import {
  ChartStylePreset,
  DashboardDevice,
  TemperatureReading,
} from '../core/models/dashboard.models';
import { environment } from '../../environments/environment';
import { capChartPointsSorted } from '../core/chart-sampling';
import { effectiveCurrentAWithNominal } from '../core/reading.utils';

type AnalysisChannel = 'temp1' | 'temp2' | 'both' | 'current';

/** Informe guardado localmente (lista en análisis; foto opcional desde cámara o galería). */
export interface StoredAnalysisInforme {
  id: string;
  createdAt: string;
  title: string;
  note: string;
  deviceId: string;
  deviceName: string;
  filterFrom: string;
  filterTo: string;
  filterDay: string;
  /** @deprecated usar seriesT1/T2/C */
  channel?: AnalysisChannel;
  seriesT1?: boolean;
  seriesT2?: boolean;
  seriesC?: boolean;
  photoDataUrl: string | null;
}

@Component({
  selector: 'app-chart-analysis',
  templateUrl: './chart-analysis.component.html',
  styleUrls: ['./chart-analysis.component.scss'],
})
export class ChartAnalysisComponent implements OnInit, OnDestroy, AfterViewInit {
  readonly environment = environment;

  devices: DashboardDevice[] = [];
  readings: TemperatureReading[] = [];

  selectedDeviceId: string | null = null;
  /**
   * `deviceId` de la query al abrir la pestaña. Mientras coincida con un equipo real,
   * no se sustituye por otro aunque no haya lecturas locales (p. ej. equipo offline).
   */
  private deviceIdFromUrl: string | null = null;

  /** Series visibles (podés combinar temperatura/s y corriente a la vez). */
  seriesShowTemp1 = true;
  seriesShowTemp2 = true;
  seriesShowCurrent = false;
  private readonly chartSeriesStorageKey = 'ar_chart_series_v1';

  sensor1LabelForm = '';
  sensor2LabelForm = '';
  sensorLabelsSaving = false;
  sensorLabelsFeedback = '';
  pdfExporting = false;
  hoverIndex: number | null = null;
  filterDay = '';
  filterFrom = '';
  filterTo = '';
  sidebarCollapsed = false;
  sidebarPeek = false;

  /** Serie para filtros de fecha en dispositivo nube (RPC Supabase). */
  remoteChartSeries: TemperatureReading[] | null = null;
  remoteChartLoading = false;
  remoteChartError = '';

  private subDev: Subscription | null = null;
  private subRead: Subscription | null = null;
  /** En navegador `setTimeout` devuelve `number` (no NodeJS.Timeout). */
  private remoteLoadTimer: number | null = null;
  /** Evita que una respuesta vieja de red pise un filtro nuevo. */
  private remoteLoadGeneration = 0;

  private readonly chartStyleStorageKey = 'ar_chart_style_v1';
  private readonly informesStorageKey = 'ar_analysis_informes_v1';
  private calibFp = '';

  informesPanelOpen = false;
  informeEditorOpen = false;
  informesList: StoredAnalysisInforme[] = [];
  informeTitleForm = '';
  informeNoteForm = '';
  informePhotoDataUrl: string | null = null;
  informeFeedback = '';
  chartStylePreset: ChartStylePreset = 'area';
  readonly chartStyleOptions: { value: ChartStylePreset; label: string }[] = [
    { value: 'area', label: 'Área (relleno suave)' },
    { value: 'line', label: 'Solo líneas' },
    { value: 'minimal', label: 'Minimal (limpio)' },
    { value: 'technical', label: 'Técnico (rejilla)' },
    { value: 'trend', label: 'Tendencia (rejilla + color por subida/bajada)' },
  ];

  /** Líneas horizontales alineadas con las 5 etiquetas del eje Y (8–92 en viewBox). */
  get chartGridYStops(): number[] {
    return [8, 29, 50, 71, 92];
  }
  readonly chartGridXStops = [20, 35, 50, 65, 80];

  /** En modo tendencia, decimar puntos para que el SVG sea fluido. */
  private readonly trendDrawPointCap = 420;

  private readonly pdfTableMaxRows = 4000;

  /**
   * Zoom horizontal sobre la serie cargada: 0–1 = fracción del rango temporal [primera, última lectura].
   * La escala Y usa solo los puntos visibles para mayor “precisión tipo regla”.
   */
  chartZoomLo = 0;
  chartZoomHi = 1;

  @ViewChild('chartSvgWrap') chartSvgWrap?: ElementRef<HTMLElement>;
  @ViewChild('chartPdfCapture') chartPdfCapture?: ElementRef<HTMLElement>;
  /** Pellizco (2 dedos): distancia inicial y ventana al empezar el gesto */
  private pinchStartDist = 0;
  private pinchStartZoomLo = 0;
  private pinchStartZoomHi = 0;
  private pinchCenterFrac = 0.5;
  private pinchActive = false;

  /** Arrastre horizontal con el zoom activo (PC y un dedo en móvil). */
  chartPanDrag = false;
  private chartPanGlobalCleanup?: () => void;
  private touchPanOneFinger = false;
  private touchPanStartX = 0;
  private touchPanStartZoomLo = 0;
  private touchPanStartZoomHi = 0;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService,
    private readonly deviceStore: DeviceStoreService
  ) {}

  ngOnInit(): void {
    // Asegura que el store use scope autenticado también en pestaña nueva.
    this.deviceStore.refreshScopeFromSession();
    this.loadChartStylePreset();
    this.loadChartSeriesPrefs();
    this.loadInformesFromStorage();

    // Soporta ambos nombres por compatibilidad: deviceId (correcto) y deviceld (typo viejo).
    const qp = this.route.snapshot.queryParamMap;
    this.selectedDeviceId = qp.get('deviceId') ?? qp.get('deviceld');
    this.deviceIdFromUrl = this.selectedDeviceId;
    const qFrom = qp.get('from')?.trim();
    const qTo = qp.get('to')?.trim();
    if (qFrom) {
      this.filterFrom = qFrom;
      this.filterDay = '';
    }
    if (qTo) {
      this.filterTo = qTo;
      this.filterDay = '';
    }

    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.devices = list;
      const checkCalibReload = () => {
        const sel = this.selectedDeviceId ? list.find((x) => x.id === this.selectedDeviceId) : undefined;
        const fp = this.calibrationFingerprint(sel);
        if (this.calibFp !== '' && fp !== this.calibFp) {
          this.scheduleRemoteChartLoad();
        }
        this.calibFp = fp;
      };
      if (list.length === 0) {
        this.syncSensorLabelsWithSelected();
        checkCalibReload();
        return;
      }
      const urlId = this.deviceIdFromUrl;
      if (urlId && list.some((d) => d.id === urlId)) {
        this.selectedDeviceId = urlId;
        this.syncSensorLabelsWithSelected();
        checkCalibReload();
        return;
      }
      if (urlId && !list.some((d) => d.id === urlId)) {
        this.deviceIdFromUrl = null;
      }
      if (!this.selectedDeviceId || !list.some((d) => d.id === this.selectedDeviceId)) {
        this.selectedDeviceId = this.pickBestDeviceId();
        this.scheduleRemoteChartLoad();
      }
      this.syncSensorLabelsWithSelected();
      checkCalibReload();
    });

    this.subRead = this.deviceStore.readings$.subscribe((list) => {
      this.readings = list;
    });

    // Primera carga del gráfico (p. ej. deviceId en URL válido sin tocar filtros).
    queueMicrotask(() => this.scheduleRemoteChartLoad());

    // Al abrir en pestaña nueva, forzamos una lectura de nube para evitar gráfico vacío.
    window.setTimeout(() => {
      this.deviceStore.forceRefreshCloudReadings();
    }, 300);
    window.setTimeout(() => {
      this.deviceStore.refreshScopeFromSession();
      this.deviceStore.forceRefreshCloudReadings();
      this.scheduleRemoteChartLoad();
    }, 1200);
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => this.attachChartInteractionListeners());
    window.setTimeout(() => this.attachChartInteractionListeners(), 400);
  }

  ngOnDestroy(): void {
    this.chartPanGlobalCleanup?.();
    this.chartPanGlobalCleanup = undefined;
    this.chartInteractionCleanup?.();
    this.chartInteractionCleanup = undefined;
    if (this.remoteLoadTimer != null) {
      clearTimeout(this.remoteLoadTimer);
      this.remoteLoadTimer = null;
    }
    this.subDev?.unsubscribe();
    this.subRead?.unsubscribe();
  }

  private chartInteractionCleanup?: () => void;

  private attachChartInteractionListeners(): void {
    const el = this.chartSvgWrap?.nativeElement;
    if (!el) return;
    this.chartInteractionCleanup?.();

    const onWheel = (e: WheelEvent) => this.onChartWheel(e);
    const onTouchStart = (e: TouchEvent) => this.onChartTouchStart(e);
    const onTouchMove = (e: TouchEvent) => this.onChartTouchMove(e);
    const onTouchEnd = (e: TouchEvent) => this.onChartTouchEnd(e);

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);

    this.chartInteractionCleanup = () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }

  private static touchDistance(a: Touch, b: Touch): number {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
  }

  onChartTouchStart(event: TouchEvent): void {
    if (!this.hasChartData) return;
    if (event.touches.length === 2) {
      this.touchPanOneFinger = false;
      this.pinchActive = true;
      const t0 = event.touches[0];
      const t1 = event.touches[1];
      this.pinchStartDist = ChartAnalysisComponent.touchDistance(t0, t1);
      if (this.pinchStartDist < 4) {
        this.pinchActive = false;
        return;
      }
      this.pinchStartZoomLo = this.chartZoomLo;
      this.pinchStartZoomHi = this.chartZoomHi;
      const el = event.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const cx = (t0.clientX + t1.clientX) / 2;
      this.pinchCenterFrac = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      event.preventDefault();
    } else if (
      event.touches.length === 1 &&
      this.chartZoomIsActive &&
      !this.pinchActive
    ) {
      this.touchPanOneFinger = true;
      this.touchPanStartX = event.touches[0].clientX;
      this.touchPanStartZoomLo = this.chartZoomLo;
      this.touchPanStartZoomHi = this.chartZoomHi;
    }
  }

  onChartTouchMove(event: TouchEvent): void {
    if (
      this.touchPanOneFinger &&
      !this.pinchActive &&
      event.touches.length === 1 &&
      this.chartZoomIsActive
    ) {
      const dx = event.touches[0].clientX - this.touchPanStartX;
      if (
        this.tryApplyChartPanByPixels(
          dx,
          this.touchPanStartZoomLo,
          this.touchPanStartZoomHi
        )
      ) {
        event.preventDefault();
      }
      return;
    }
    if (!this.pinchActive || event.touches.length !== 2) return;
    const t0 = event.touches[0];
    const t1 = event.touches[1];
    const d = ChartAnalysisComponent.touchDistance(t0, t1);
    if (d < 4 || this.pinchStartDist < 4) return;

    const W0 = this.pinchStartZoomHi - this.pinchStartZoomLo;
    let newW = W0 * (this.pinchStartDist / d);
    newW = Math.max(1e-5, Math.min(1, newW));

    const pos = this.pinchStartZoomLo + this.pinchCenterFrac * W0;
    let newLo = pos - this.pinchCenterFrac * newW;
    let newHi = pos + (1 - this.pinchCenterFrac) * newW;
    if (newLo < 0) {
      newHi -= newLo;
      newLo = 0;
    }
    if (newHi > 1) {
      newLo -= newHi - 1;
      newHi = 1;
    }
    newLo = Math.max(0, newLo);
    newHi = Math.min(1, newHi);
    if (newHi - newLo < 1e-5) return;

    const full = this.chartReadings();
    if (full.length < 2) return;
    const domPinch = this.getChartTimeDomainMs();
    if (!domPinch) return;
    const span = domPinch.toMs - domPinch.fromMs;
    if (!Number.isFinite(span) || span <= 0) return;
    const ta = domPinch.fromMs + newLo * span;
    const tb = domPinch.fromMs + newHi * span;
    const count = full.filter((r) => {
      const t = new Date(r.at).getTime();
      return t >= ta && t <= tb;
    }).length;
    if (count < 2) return;

    this.chartZoomLo = newLo;
    this.chartZoomHi = newHi;
    event.preventDefault();
  }

  onChartTouchEnd(event: TouchEvent): void {
    if (event.touches.length === 0) {
      this.touchPanOneFinger = false;
    }
    if (event.touches.length < 2) {
      this.pinchActive = false;
    }
  }

  /** Zoom centrado (p. ej. botones en móvil). factor menor que 1 = acercar. */
  chartZoomStep(factor: number): void {
    if (!this.hasChartData) return;
    const curW = this.chartZoomHi - this.chartZoomLo;
    this.tryApplyChartZoomWindow(curW * factor, 0.5);
  }

  chartZoomIn(): void {
    this.chartZoomStep(0.88);
  }

  chartZoomOut(): void {
    this.chartZoomStep(1.12);
  }

  /**
   * Dominio temporal del eje X: con Desde/Hasta usa ese rango (aunque falten lecturas al final);
   * sin filtro de fechas usa primera→última lectura cargada.
   */
  private getChartTimeDomainMs(): { fromMs: number; toMs: number } | null {
    const ub = this.getUserDateFilterBounds();
    if (ub) {
      const fromMs = ub.from.getTime();
      const toMs = ub.to.getTime();
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return null;
      return { fromMs, toMs };
    }
    const full = this.chartReadings();
    if (full.length < 1) return null;
    if (full.length === 1) {
      const t = new Date(full[0].at).getTime();
      return { fromMs: t, toMs: t + 1 };
    }
    const t0 = new Date(full[0].at).getTime();
    const t1 = new Date(full[full.length - 1].at).getTime();
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 >= t1) return null;
    return { fromMs: t0, toMs: t1 };
  }

  /** Ventana temporal actual (incluye zoom [lo,hi] sobre el dominio). */
  private getChartVisibleTimeRangeMs(): { t0: number; t1: number } | null {
    const dom = this.getChartTimeDomainMs();
    if (!dom) return null;
    const span = dom.toMs - dom.fromMs;
    if (!Number.isFinite(span) || span <= 0) return null;
    return {
      t0: dom.fromMs + this.chartZoomLo * span,
      t1: dom.fromMs + this.chartZoomHi * span,
    };
  }

  /** Posición X en el viewBox 0–100 según tiempo dentro de la ventana visible. */
  private chartSvgXForTimeMs(t: number): number | null {
    const vis = this.getChartVisibleTimeRangeMs();
    if (!vis || vis.t1 <= vis.t0) return null;
    const x = ((t - vis.t0) / (vis.t1 - vis.t0)) * 100;
    return Math.max(0, Math.min(100, x));
  }

  /**
   * Ajusta el ancho normalizado del rango visible [0,1], anclado en `frac` (0=izq, 1=der).
   */
  private tryApplyChartZoomWindow(newW: number, frac: number): boolean {
    if (!this.hasChartData) return false;
    const full = this.chartReadings();
    if (full.length < 2) return false;
    const dom = this.getChartTimeDomainMs();
    if (!dom) return false;
    const span = dom.toMs - dom.fromMs;
    if (!Number.isFinite(span) || span <= 0) return false;
    const tMin = dom.fromMs;

    const pos = this.chartZoomLo + frac * (this.chartZoomHi - this.chartZoomLo);
    let w = Math.max(1e-5, Math.min(1, newW));
    let newLo = pos - frac * w;
    let newHi = pos + (1 - frac) * w;
    if (newLo < 0) {
      newHi -= newLo;
      newLo = 0;
    }
    if (newHi > 1) {
      newLo -= newHi - 1;
      newHi = 1;
    }
    newLo = Math.max(0, newLo);
    newHi = Math.min(1, newHi);
    if (newHi - newLo < 1e-5) return false;

    const ta = tMin + newLo * span;
    const tb = tMin + newHi * span;
    const count = full.filter((r) => {
      const t = new Date(r.at).getTime();
      return t >= ta && t <= tb;
    }).length;
    if (count < 2) return false;

    this.chartZoomLo = newLo;
    this.chartZoomHi = newHi;
    return true;
  }

  /**
   * Desplaza la ventana [lo,hi] en el tiempo (arrastre lateral tras zoom).
   * dx > 0 = arrastre hacia la derecha → ver tiempos anteriores.
   */
  private tryApplyChartPanByPixels(
    dx: number,
    panStartZoomLo: number,
    panStartZoomHi: number
  ): boolean {
    if (!this.hasChartData) return false;
    const el = this.chartSvgWrap?.nativeElement;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return false;
    const W0 = panStartZoomHi - panStartZoomLo;
    const deltaNorm = (dx / rect.width) * W0;
    let newLo = panStartZoomLo - deltaNorm;
    let newHi = panStartZoomHi - deltaNorm;
    if (newLo < 0) {
      newHi -= newLo;
      newLo = 0;
    }
    if (newHi > 1) {
      newLo -= newHi - 1;
      newHi = 1;
    }
    newLo = Math.max(0, newLo);
    newHi = Math.min(1, newHi);
    if (newHi - newLo < 1e-5) return false;

    const full = this.chartReadings();
    if (full.length < 2) return false;
    const dom = this.getChartTimeDomainMs();
    if (!dom) return false;
    const span = dom.toMs - dom.fromMs;
    if (!Number.isFinite(span) || span <= 0) return false;
    const ta = dom.fromMs + newLo * span;
    const tb = dom.fromMs + newHi * span;
    const count = full.filter((r) => {
      const t = new Date(r.at).getTime();
      return t >= ta && t <= tb;
    }).length;
    if (count < 2) return false;

    this.chartZoomLo = newLo;
    this.chartZoomHi = newHi;
    return true;
  }

  onChartMouseDown(event: MouseEvent): void {
    if (event.button !== 0 || !this.hasChartData || !this.chartZoomIsActive) return;
    const panStartClientX = event.clientX;
    const panStartZoomLo = this.chartZoomLo;
    const panStartZoomHi = this.chartZoomHi;
    const el = this.chartSvgWrap?.nativeElement;
    if (!el) return;

    this.chartPanDrag = true;
    this.chartPanGlobalCleanup?.();
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - panStartClientX;
      this.tryApplyChartPanByPixels(dx, panStartZoomLo, panStartZoomHi);
    };
    const onUp = () => {
      this.chartPanDrag = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this.chartPanGlobalCleanup = undefined;
    };
    this.chartPanGlobalCleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    event.preventDefault();
  }

  get selectedDevice(): DashboardDevice | null {
    if (!this.selectedDeviceId) return null;
    return this.devices.find((d) => d.id === this.selectedDeviceId) ?? null;
  }

  get selectedIsCloudDevice(): boolean {
    return this.deviceStore.isCloudDeviceId(this.selectedDeviceId);
  }

  /**
   * Texto del rango que usa el gráfico (nube o filtros), para móvil y confirmación Desde/Hasta.
   */
  get chartBoundsSummaryLine(): string {
    const b = this.getEffectiveChartBounds();
    if (!b) return '';
    const fmt = (d: Date) =>
      d.toLocaleString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    return `${fmt(b.from)} → ${fmt(b.to)}`;
  }

  get hasSecondSeries(): boolean {
    return this.chartReadings().some((r) => r.temp2C != null && Number.isFinite(r.temp2C));
  }

  get hasCurrentSeries(): boolean {
    const v = this.selectedDevice?.nominalVoltageV;
    return this.chartReadings().some((r) => effectiveCurrentAWithNominal(r, v) != null);
  }

  /** Canal corriente (A) en el selector */
  get analysisShowsCurrent(): boolean {
    return this.seriesShowCurrent;
  }

  /** Temperatura(s) y corriente a la vez → dos escalas Y. */
  get chartDualAxis(): boolean {
    return this.seriesShowCurrent && (this.seriesShowTemp1 || this.seriesShowTemp2);
  }

  get hasChartData(): boolean {
    const s = this.chartReadings();
    if (s.length < 2) return false;
    if (this.seriesShowCurrent && !this.seriesShowTemp1 && !this.seriesShowTemp2) {
      const filled = this.currentSeriesForwardFilled(s);
      return filled.some((v) => v != null && Number.isFinite(v as number));
    }
    if (this.seriesShowTemp1 || this.seriesShowTemp2) {
      return true;
    }
    if (this.seriesShowCurrent) {
      const filled = this.currentSeriesForwardFilled(s);
      return filled.some((v) => v != null && Number.isFinite(v as number));
    }
    return false;
  }

  /** Hay filtro de fechas explícito pero no alcanza puntos para dibujar la curva */
  get filterActiveButNoPoints(): boolean {
    if (!this.hasUserDateFilter()) return false;
    if (this.remoteChartLoading) return false;
    return this.chartReadings().length < 2;
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
    return this.seriesShowTemp1;
  }

  get showTemp2(): boolean {
    return this.seriesShowTemp2 && this.hasSecondSeries;
  }

  get hoverX(): number | null {
    if (this.hoverIndex == null) return null;
    const s = this.chartPointsForDraw();
    if (!s.length) return null;
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    const t = new Date(s[idx].at).getTime();
    return this.chartSvgXForTimeMs(t);
  }

  get hoverYTemp1(): number | null {
    if (this.hoverIndex == null || !this.showTemp1) return null;
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return null;
    return this.chartScaleTemp().toSvgY(s[idx].temperatureC);
  }

  get hoverYTemp2(): number | null {
    if (this.hoverIndex == null || !this.showTemp2) return null;
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return null;
    const filled = this.temp2SeriesForwardFilled(s);
    const t2 = filled[idx];
    if (t2 == null || Number.isNaN(t2)) return null;
    return this.chartScaleTemp().toSvgY(t2);
  }

  get hoverTimeLabel(): string {
    if (this.hoverIndex == null) return '';
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return '';
    return this.formatChartDateTime(s[idx].at, this.chartVisibleSpanMs());
  }

  get hoverTemp1Label(): string {
    if (this.hoverIndex == null || !this.showTemp1) return '—';
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return '—';
    const d = this.tempDecimalsForDisplay();
    return `${s[idx].temperatureC.toFixed(d)}°C`;
  }

  get hoverTemp2Label(): string {
    if (this.hoverIndex == null || !this.showTemp2) return '—';
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    if (!s[idx]) return '—';
    const filled = this.temp2SeriesForwardFilled(s);
    const t2 = filled[idx];
    if (t2 == null || Number.isNaN(t2)) return '—';
    const d = this.tempDecimalsForDisplay();
    return `${t2.toFixed(d)}°C`;
  }

  get hoverYCurrent(): number | null {
    if (this.hoverIndex == null || !this.analysisShowsCurrent) return null;
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    const filled = this.currentSeriesForwardFilled(s);
    const amps = filled[idx];
    if (amps == null || Number.isNaN(amps)) return null;
    return this.chartScaleCurrent().toSvgY(amps);
  }

  get hoverCurrentLabel(): string {
    if (this.hoverIndex == null || !this.analysisShowsCurrent) return '—';
    const s = this.chartPointsForDraw();
    const idx = Math.min(Math.max(this.hoverIndex, 0), s.length - 1);
    const filled = this.currentSeriesForwardFilled(s);
    const amps = filled[idx];
    if (amps == null || Number.isNaN(amps)) return '—';
    return `${amps.toFixed(2)} A`;
  }

  loadChartSeriesPrefs(): void {
    try {
      const raw = localStorage.getItem(this.chartSeriesStorageKey);
      if (!raw) return;
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (typeof o['t1'] === 'boolean') this.seriesShowTemp1 = o['t1'];
      if (typeof o['t2'] === 'boolean') this.seriesShowTemp2 = o['t2'];
      if (typeof o['c'] === 'boolean') this.seriesShowCurrent = o['c'];
      this.ensureAtLeastOneSeries();
    } catch {
      /* */
    }
  }

  private saveChartSeriesPrefs(): void {
    try {
      localStorage.setItem(
        this.chartSeriesStorageKey,
        JSON.stringify({
          t1: this.seriesShowTemp1,
          t2: this.seriesShowTemp2,
          c: this.seriesShowCurrent,
        })
      );
    } catch {
      /* */
    }
  }

  private ensureAtLeastOneSeries(): void {
    if (!this.seriesShowTemp1 && !this.seriesShowTemp2 && !this.seriesShowCurrent) {
      this.seriesShowTemp1 = true;
    }
  }

  onSeriesCheckboxChange(): void {
    this.ensureAtLeastOneSeries();
    this.saveChartSeriesPrefs();
  }

  /** Mismo criterio que el panel principal: relleno bajo la curva en área / técnico. */
  chartShowsAreaFill(): boolean {
    return this.chartStylePreset === 'area' || this.chartStylePreset === 'technical';
  }

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

  get avgDeltaLabel(): string {
    const series = this.chartReadingsZoomed();
    if (this.seriesShowCurrent && !this.seriesShowTemp1 && !this.seriesShowTemp2) {
      const filled = this.currentSeriesForwardFilled(series);
      const n = filled.length;
      if (n < 2) return '—';
      const last = filled[n - 1];
      const prev = filled[n - 2];
      if (last == null || prev == null || Number.isNaN(last) || Number.isNaN(prev)) return '—';
      const d = last - prev;
      const sign = d >= 0 ? '+' : '';
      return `${sign}${d.toFixed(2)} A`;
    }
    if (this.chartDualAxis) {
      const parts: string[] = [];
      if (this.showTemp1 && series.length >= 2) {
        const last1 = series[series.length - 1].temperatureC;
        const prev1 = series[series.length - 2].temperatureC;
        const d1 = last1 - prev1;
        parts.push(`${this.sensor1Name} ${d1 >= 0 ? '+' : ''}${d1.toFixed(1)}°C`);
      }
      if (this.showTemp2 && this.hasSecondSeries && series.length >= 2) {
        const filled = this.temp2SeriesForwardFilled(series);
        const last2 = filled[series.length - 1];
        const prev2 = filled[series.length - 2];
        if (last2 != null && prev2 != null && !Number.isNaN(last2) && !Number.isNaN(prev2)) {
          const d2 = last2 - prev2;
          parts.push(`${this.sensor2Name} ${d2 >= 0 ? '+' : ''}${d2.toFixed(1)}°C`);
        }
      }
      if (this.seriesShowCurrent) {
        const filled = this.currentSeriesForwardFilled(series);
        const n = filled.length;
        if (n >= 2) {
          const last = filled[n - 1];
          const prev = filled[n - 2];
          if (last != null && prev != null && !Number.isNaN(last) && !Number.isNaN(prev)) {
            const d = last - prev;
            parts.push(`I ${d >= 0 ? '+' : ''}${d.toFixed(2)} A`);
          }
        }
      }
      return parts.length ? parts.join('\n') : '—';
    }
    if (this.showTemp1 && this.showTemp2) {
      if (series.length < 2) return '—';
      const last1 = series[series.length - 1].temperatureC;
      const prev1 = series[series.length - 2].temperatureC;
      const filled = this.temp2SeriesForwardFilled(series);
      const last2 = filled[series.length - 1];
      const prev2 = filled[series.length - 2];
      const d1 = last1 - prev1;
      const s1 = d1 >= 0 ? '+' : '';
      const line1 = `${this.sensor1Name} ${s1}${d1.toFixed(1)}°C`;
      if (
        last2 == null ||
        prev2 == null ||
        Number.isNaN(last2) ||
        Number.isNaN(prev2) ||
        !this.hasSecondSeries
      ) {
        return line1;
      }
      const d2 = last2 - prev2;
      const s2 = d2 >= 0 ? '+' : '';
      return `${line1}\n${this.sensor2Name} ${s2}${d2.toFixed(1)}°C`;
    }
    if (this.showTemp1 && !this.showTemp2) {
      const last = series.length ? series[series.length - 1].temperatureC : null;
      const prev = series.length > 1 ? series[series.length - 2].temperatureC : null;
      if (last == null || prev == null) return '—';
      const d = last - prev;
      const sign = d >= 0 ? '+' : '';
      return `${sign}${d.toFixed(1)}°C`;
    }
    if (!this.showTemp1 && this.showTemp2) {
      const filled = this.temp2SeriesForwardFilled(series);
      const n = filled.length;
      if (n < 2) return '—';
      const last = filled[n - 1];
      const prev = filled[n - 2];
      if (last == null || prev == null || Number.isNaN(last) || Number.isNaN(prev)) return '—';
      const d = last - prev;
      const sign = d >= 0 ? '+' : '';
      return `${sign}${d.toFixed(1)}°C`;
    }
    return '—';
  }

  /** Min/máx en el rango visible (solo canales visibles según el selector). */
  get chartTempRangeLabel(): string {
    const series = this.chartReadingsZoomed();
    if (!series.length) return '—';
    const parts: string[] = [];
    if (this.showTemp1) {
      const t1 = series.map((r) => r.temperatureC);
      parts.push(
        `${this.sensor1Name} min ${Math.min(...t1).toFixed(1)} · max ${Math.max(...t1).toFixed(1)}°C`
      );
    }
    if (this.showTemp2 && this.hasSecondSeries) {
      const t2vals = series
        .map((r) => r.temp2C)
        .filter((x): x is number => x != null && !Number.isNaN(x));
      if (t2vals.length) {
        parts.push(
          `${this.sensor2Name} min ${Math.min(...t2vals).toFixed(1)} · max ${Math.max(...t2vals).toFixed(1)}°C`
        );
      }
    }
    if (!parts.length) return '—';
    return parts.length > 1 ? parts.join('\n') : parts[0];
  }

  /** Δ con dos sensores: mostrar en columna en lugar de una línea larga. */
  get avgDeltaIsMultiline(): boolean {
    return this.avgDeltaLabel.includes('\n');
  }

  get chartCurrentRangeLabel(): string {
    if (!this.seriesShowCurrent) return '—';
    const series = this.chartReadingsZoomed();
    const filled = this.currentSeriesForwardFilled(series);
    const vals = filled.filter((x): x is number => x != null && Number.isFinite(x));
    if (!vals.length) return '—';
    return `I min ${Math.min(...vals).toFixed(2)} · max ${Math.max(...vals).toFixed(2)} A`;
  }

  get chartSideRangeLabel(): string {
    if (this.chartDualAxis) {
      const a = this.chartTempRangeLabel;
      const b = this.chartCurrentRangeLabel;
      if (a === '—') return b;
      if (b === '—') return a;
      return `${a}\n${b}`;
    }
    return this.seriesShowCurrent && !this.seriesShowTemp1 && !this.seriesShowTemp2
      ? this.chartCurrentRangeLabel
      : this.chartTempRangeLabel;
  }

  clearDateFilters(): void {
    this.filterDay = '';
    this.filterFrom = '';
    this.filterTo = '';
    this.clearRemoteChartState();
    this.resetChartZoom();
    // Sin esto, en equipo nube la serie queda en null y chartReadingsImpl devuelve [] hasta otro evento.
    this.scheduleRemoteChartLoad();
  }

  onFilterDayChange(): void {
    // Evita mezclar "Día exacto" con "rango"
    if (this.filterDay) {
      this.filterFrom = '';
      this.filterTo = '';
    }
    this.resetChartZoom();
    this.scheduleRemoteChartLoad();
  }

  onFilterRangeChange(): void {
    // Si el usuario usa rango, desactiva "Día exacto"
    if (this.filterFrom || this.filterTo) {
      this.filterDay = '';
    }
    this.resetChartZoom();
    this.scheduleRemoteChartLoad();
  }

  onChartDeviceChange(): void {
    this.deviceIdFromUrl = null;
    this.syncSensorLabelsWithSelected();
    this.resetChartZoom();
    this.scheduleRemoteChartLoad();
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
    if (this.chartPanDrag) return;
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const series = this.chartPointsForDraw();
    if (!series.length) {
      this.hoverIndex = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rel = (event.clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, rel));
    const vis = this.getChartVisibleTimeRangeMs();
    if (!vis || vis.t1 <= vis.t0) {
      this.hoverIndex = Math.round(clamped * (series.length - 1));
      return;
    }
    const tTarget = vis.t0 + clamped * (vis.t1 - vis.t0);
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < series.length; i++) {
      const t = new Date(series[i].at).getTime();
      const d = Math.abs(t - tTarget);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.hoverIndex = best;
  }

  onChartMouseLeave(): void {
    if (!this.chartPanDrag) {
      this.hoverIndex = null;
    }
  }

  /** Serie temporal tras el zoom (misma base que el gráfico). */
  private chartReadingsZoomed(): TemperatureReading[] {
    const full = this.chartReadings();
    if (full.length < 2) return full;
    const dom = this.getChartTimeDomainMs();
    if (!dom) return full;
    const span = dom.toMs - dom.fromMs;
    if (!Number.isFinite(span) || span <= 0) return full;
    const ta = dom.fromMs + this.chartZoomLo * span;
    const tb = dom.fromMs + this.chartZoomHi * span;
    const out = full.filter((r) => {
      const t = new Date(r.at).getTime();
      return t >= ta && t <= tb;
    });
    if (out.length < 2 && full.length >= 2) return full;
    return out;
  }

  get chartZoomIsActive(): boolean {
    return this.chartZoomLo > 0.0005 || this.chartZoomHi < 0.9995;
  }

  resetChartZoom(): void {
    this.chartZoomLo = 0;
    this.chartZoomHi = 1;
  }

  /**
   * Rueda: acerca/aleja el rango visible (centrado en el cursor).
   * deltaY negativo = acercar (más detalle en tiempo y en °C).
   */
  onChartWheel(event: WheelEvent): void {
    if (!this.hasChartData) return;
    const full = this.chartReadings();
    if (full.length < 2) return;
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const curW = this.chartZoomHi - this.chartZoomLo;
    const factor = event.deltaY < 0 ? 0.88 : 1.12;
    if (!this.tryApplyChartZoomWindow(curW * factor, frac)) return;
    event.preventDefault();
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

  get chartCurrentLabel1(): string {
    if (!this.showTemp1) return '—';
    const series = this.chartReadingsZoomed();
    const n = series.length;
    if (!n) return '—';
    const v = series[n - 1].temperatureC;
    return `${v.toFixed(1)}°C`;
  }

  get chartCurrentLabel2(): string {
    if (!this.showTemp2 || !this.hasSecondSeries) return '—';
    const series = this.chartReadingsZoomed();
    const n = series.length;
    if (!n) return '—';
    const filled = this.temp2SeriesForwardFilled(series);
    const v = filled[n - 1];
    if (v == null || Number.isNaN(v)) return '—';
    return `${v.toFixed(1)}°C`;
  }

  get chartLatestCurrentLabel(): string {
    if (!this.analysisShowsCurrent) return '—';
    const series = this.chartReadingsZoomed();
    const filled = this.currentSeriesForwardFilled(series);
    const n = filled.length;
    if (!n) return '—';
    const v = filled[n - 1];
    if (v == null || Number.isNaN(v)) return '—';
    return `${v.toFixed(2)} A`;
  }

  private chartValueRangeTemp(): { minV: number; maxV: number; span: number } | null {
    const series = this.chartReadingsZoomed();
    if (!series.length) return null;
    const vals: number[] = [];
    if (this.seriesShowTemp1) vals.push(...series.map((r) => r.temperatureC));
    if (this.seriesShowTemp2 && this.hasSecondSeries) {
      const filled = this.temp2SeriesForwardFilled(series);
      for (const t of filled) {
        if (t != null && Number.isFinite(t)) vals.push(t);
      }
    }
    if (!vals.length) return null;
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    return { minV, maxV, span: maxV - minV };
  }

  private chartValueRangeCurrent(): { minV: number; maxV: number; span: number } | null {
    const series = this.chartReadingsZoomed();
    if (!series.length) return null;
    const filled = this.currentSeriesForwardFilled(series);
    const vals = filled.filter((x): x is number => x != null && Number.isFinite(x));
    if (!vals.length) return null;
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    return { minV, maxV, span: maxV - minV };
  }

  private chartPaddedBoundsTemp(): { minV: number; maxV: number; span: number } | null {
    const raw = this.chartValueRangeTemp();
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

  private chartPaddedBoundsCurrent(): { minV: number; maxV: number; span: number } | null {
    const raw = this.chartValueRangeCurrent();
    if (!raw) return null;
    let { minV, maxV, span } = raw;
    if (span < 1e-6) {
      span = Math.max(0.5, Math.abs(maxV) * 0.25, 0.15);
      return { minV: minV - span / 2, maxV: maxV + span / 2, span };
    }
    const pad = Math.max(0.05, span * 0.08);
    minV = minV - pad;
    maxV = maxV + pad;
    return { minV, maxV, span: maxV - minV };
  }

  private chartScaleTemp(): { toSvgY: (v: number) => number } {
    const padded = this.chartPaddedBoundsTemp();
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

  private chartScaleCurrent(): { toSvgY: (v: number) => number } {
    const padded = this.chartPaddedBoundsCurrent();
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

  /** Cinco marcas eje Y izquierdo (°C; si solo corriente, A en esta columna). */
  get chartYAxisLabelsFromTop(): string[] {
    const n = 5;
    const dash = (): string[] => Array(n).fill('—');
    if (this.chartDualAxis) {
      const padded = this.chartPaddedBoundsTemp();
      if (!padded) return dash();
      const tempDec = this.tempDecimalsForDisplay();
      const labels: string[] = [];
      for (let i = 0; i < n; i++) {
        const ratio = (n - 1 - i) / (n - 1);
        const v = padded.minV + ratio * (padded.maxV - padded.minV);
        labels.push(`${v.toFixed(tempDec)}°C`);
      }
      return labels;
    }
    if (this.seriesShowCurrent && !this.seriesShowTemp1 && !this.seriesShowTemp2) {
      const padded = this.chartPaddedBoundsCurrent();
      if (!padded) return dash();
      const labels: string[] = [];
      for (let i = 0; i < n; i++) {
        const ratio = (n - 1 - i) / (n - 1);
        const v = padded.minV + ratio * (padded.maxV - padded.minV);
        labels.push(`${this.formatCurrentAxisTick(v, padded.span)} A`);
      }
      return labels;
    }
    const padded = this.chartPaddedBoundsTemp();
    if (!padded) return dash();
    const tempDec = this.tempDecimalsForDisplay();
    const labels: string[] = [];
    for (let i = 0; i < n; i++) {
      const ratio = (n - 1 - i) / (n - 1);
      const v = padded.minV + ratio * (padded.maxV - padded.minV);
      labels.push(`${v.toFixed(tempDec)}°C`);
    }
    return labels;
  }

  /** Eje Y derecho: corriente (solo con temperatura + corriente a la vez). */
  get chartYAxisLabelsRightFromTop(): string[] {
    const n = 5;
    if (!this.chartDualAxis) return [];
    const padded = this.chartPaddedBoundsCurrent();
    if (!padded) return Array(n).fill('—');
    const labels: string[] = [];
    for (let i = 0; i < n; i++) {
      const ratio = (n - 1 - i) / (n - 1);
      const v = padded.minV + ratio * (padded.maxV - padded.minV);
      labels.push(`${this.formatCurrentAxisTick(v, padded.span)} A`);
    }
    return labels;
  }

  /** Decimales en °C según el rango visible (más zoom → más precisión). */
  private tempDecimalsForDisplay(): number {
    if (this.seriesShowCurrent && !this.seriesShowTemp1 && !this.seriesShowTemp2) return 1;
    const padded = this.chartPaddedBoundsTemp();
    if (!padded) return 1;
    if (padded.span < 0.4) return 2;
    if (padded.span < 1.2) return 2;
    return 1;
  }

  private chartVisibleSpanMs(): number {
    const vis = this.getChartVisibleTimeRangeMs();
    if (!vis) return 86400000;
    return Math.max(0, vis.t1 - vis.t0);
  }

  /** Etiquetas de tiempo en el eje X (inicio → fin del rango mostrado). */
  get chartXAxisTickLabels(): string[] {
    const vis = this.getChartVisibleTimeRangeMs();
    if (!vis || vis.t1 <= vis.t0) return [];
    const spanMs = vis.t1 - vis.t0;
    const ticks = 5;
    const labels: string[] = [];
    for (let i = 0; i < ticks; i++) {
      const ratio = i / (ticks - 1);
      const ms = vis.t0 + ratio * (vis.t1 - vis.t0);
      labels.push(this.formatChartAxisTimeLabel(new Date(ms).toISOString(), spanMs));
    }
    return labels;
  }

  /** Eje X: con zoom fuerte muestra segundos (y milisegundos si el rango es muy corto). */
  private formatChartAxisTimeLabel(iso: string, spanMs: number): string {
    try {
      const d = new Date(iso);
      const opts: Intl.DateTimeFormatOptions = {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      };
      if (spanMs < 48 * 60 * 60 * 1000) {
        opts.second = '2-digit';
      }
      return d.toLocaleString('es-AR', opts);
    } catch {
      return iso;
    }
  }

  private formatCurrentAxisTick(value: number, span: number): string {
    if (span >= 40) return value.toFixed(1);
    if (span >= 8) return value.toFixed(2);
    return value.toFixed(3);
  }

  chartPolylinePointsS1(): string {
    if (!this.showTemp1) return '';
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return '0,50 100,50';
    const sc = this.chartScaleTemp();
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = series[i];
      const t = new Date(r.at).getTime();
      const x = this.chartSvgXForTimeMs(t);
      if (x == null) continue;
      pts.push(`${x},${sc.toSvgY(r.temperatureC)}`);
    }
    return pts.length >= 2 ? pts.join(' ') : '0,50 100,50';
  }

  chartPolylinePointsS2(): string {
    if (!this.showTemp2) return '';
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return '';
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScaleTemp();
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const t2 = filled[i];
      if (t2 == null || Number.isNaN(t2)) continue;
      const t = new Date(series[i].at).getTime();
      const x = this.chartSvgXForTimeMs(t);
      if (x == null) continue;
      pts.push(`${x},${sc.toSvgY(t2)}`);
    }
    return pts.length >= 2 ? pts.join(' ') : '';
  }

  chartPolylinePointsCurrent(): string {
    if (!this.analysisShowsCurrent) return '';
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return '0,50 100,50';
    const filled = this.currentSeriesForwardFilled(series);
    const sc = this.chartScaleCurrent();
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const pw = filled[i];
      if (pw == null || Number.isNaN(pw)) continue;
      const t = new Date(series[i].at).getTime();
      const x = this.chartSvgXForTimeMs(t);
      if (x == null) continue;
      pts.push(`${x},${sc.toSvgY(pw)}`);
    }
    return pts.length >= 2 ? pts.join(' ') : '0,50 100,50';
  }

  /** Polígono de relleno bajo la curva (base entre primera y última X en tiempo). */
  private chartAreaFillFromPolyline(polyline: string): string {
    if (!polyline || polyline === '0,50 100,50') return '';
    const coords = polyline.trim().split(/\s+/).filter(Boolean);
    if (coords.length < 2) return '';
    const first = coords[0].split(',');
    const last = coords[coords.length - 1].split(',');
    const fx = first[0];
    const lx = last[0];
    return `${fx},100 ${polyline} ${lx},100`;
  }

  chartAreaPointsS1(): string {
    return this.chartAreaFillFromPolyline(this.chartPolylinePointsS1());
  }

  chartAreaPointsS2(): string {
    return this.chartAreaFillFromPolyline(this.chartPolylinePointsS2());
  }

  chartAreaPointsCurrent(): string {
    return this.chartAreaFillFromPolyline(this.chartPolylinePointsCurrent());
  }

  /**
   * Puntos que se dibujan: en modo tendencia se deciman para no generar miles de segmentos.
   * La escala Y usa la serie visible (incluye zoom horizontal).
   */
  chartPointsForDraw(): TemperatureReading[] {
    const s = this.chartReadingsZoomed();
    if (this.chartStylePreset !== 'trend') return s;
    return this.evenSampleReadings(s, this.trendDrawPointCap);
  }

  private evenSampleReadings(arr: TemperatureReading[], cap: number): TemperatureReading[] {
    if (arr.length <= cap) return [...arr];
    const out: TemperatureReading[] = [];
    const last = arr.length - 1;
    for (let i = 0; i < cap; i++) {
      const idx = Math.round((i * last) / (cap - 1));
      out.push(arr[idx]);
    }
    return out;
  }

  chartTrendSegments1(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> {
    if (this.chartStylePreset !== 'trend' || !this.showTemp1) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const sc = this.chartScaleTemp();
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
      const x1 = this.chartSvgXForTimeMs(new Date(series[i].at).getTime());
      const x2 = this.chartSvgXForTimeMs(new Date(series[i + 1].at).getTime());
      if (x1 == null || x2 == null) continue;
      out.push({ x1, y1: sc.toSvgY(t0), x2, y2: sc.toSvgY(t1), trend });
    }
    return out;
  }

  chartTrendMarkers1(): Array<{ cx: number; cy: number }> {
    if (this.chartStylePreset !== 'trend' || !this.showTemp1) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const sc = this.chartScaleTemp();
    const pts: Array<{ cx: number; cy: number }> = [];
    for (const r of series) {
      const x = this.chartSvgXForTimeMs(new Date(r.at).getTime());
      if (x == null) continue;
      pts.push({ cx: x, cy: sc.toSvgY(r.temperatureC) });
    }
    return pts;
  }

  chartTrendSegments2(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> {
    if (this.chartStylePreset !== 'trend' || !this.showTemp2 || !this.hasSecondSeries) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScaleTemp();
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
      const x1 = this.chartSvgXForTimeMs(new Date(series[i].at).getTime());
      const x2 = this.chartSvgXForTimeMs(new Date(series[i + 1].at).getTime());
      if (x1 == null || x2 == null) continue;
      out.push({ x1, y1: sc.toSvgY(t0), x2, y2: sc.toSvgY(t1), trend });
    }
    return out;
  }

  chartTrendMarkers2(): Array<{ cx: number; cy: number }> {
    if (this.chartStylePreset !== 'trend' || !this.showTemp2 || !this.hasSecondSeries) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const filled = this.temp2SeriesForwardFilled(series);
    const sc = this.chartScaleTemp();
    const pts: Array<{ cx: number; cy: number }> = [];
    for (let i = 0; i < n; i++) {
      const t = filled[i];
      if (t == null || Number.isNaN(t)) continue;
      const x = this.chartSvgXForTimeMs(new Date(series[i].at).getTime());
      if (x == null) continue;
      pts.push({ cx: x, cy: sc.toSvgY(t) });
    }
    return pts;
  }

  chartTrendSegmentsCurrent(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    trend: 'up' | 'down' | 'flat';
  }> {
    if (this.chartStylePreset !== 'trend' || !this.analysisShowsCurrent) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const filled = this.currentSeriesForwardFilled(series);
    const sc = this.chartScaleCurrent();
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
      const x1 = this.chartSvgXForTimeMs(new Date(series[i].at).getTime());
      const x2 = this.chartSvgXForTimeMs(new Date(series[i + 1].at).getTime());
      if (x1 == null || x2 == null) continue;
      out.push({ x1, y1: sc.toSvgY(t0), x2, y2: sc.toSvgY(t1), trend });
    }
    return out;
  }

  chartTrendMarkersCurrent(): Array<{ cx: number; cy: number }> {
    if (this.chartStylePreset !== 'trend' || !this.analysisShowsCurrent) return [];
    const series = this.chartPointsForDraw();
    const n = series.length;
    if (n < 2) return [];
    const filled = this.currentSeriesForwardFilled(series);
    const sc = this.chartScaleCurrent();
    const pts: Array<{ cx: number; cy: number }> = [];
    for (let i = 0; i < n; i++) {
      const t = filled[i];
      if (t == null || Number.isNaN(t)) continue;
      const x = this.chartSvgXForTimeMs(new Date(series[i].at).getTime());
      if (x == null) continue;
      pts.push({ cx: x, cy: sc.toSvgY(t) });
    }
    return pts;
  }

  private chartReadings(): TemperatureReading[] {
    return this.chartReadingsImpl(true);
  }

  /** Misma serie que el gráfico, sin tope de puntos (p. ej. exportación PDF). */
  private chartReadingsUncapped(): TemperatureReading[] {
    return this.chartReadingsImpl(false);
  }

  private chartReadingsImpl(applyDisplayCap: boolean): TemperatureReading[] {
    if (!this.selectedDeviceId) return [];

    const bounds = this.getEffectiveChartBounds();
    const useRemote =
      bounds !== null &&
      this.deviceStore.isCloudSyncActive() &&
      this.deviceStore.isCloudDeviceId(this.selectedDeviceId);

    if (useRemote) {
      if (this.remoteChartLoading) return [];
      if (this.remoteChartSeries !== null) {
        const sorted = [...this.remoteChartSeries].sort(
          (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
        );
        return applyDisplayCap ? capChartPointsSorted(sorted) : sorted;
      }
      if (this.remoteChartError) {
        return this.chartReadingsLocalFiltered(applyDisplayCap);
      }
      return [];
    }

    return this.chartReadingsLocalFiltered(applyDisplayCap);
  }

  private chartReadingsLocalFiltered(applyDisplayCap = true): TemperatureReading[] {
    if (!this.selectedDeviceId) return [];
    const source = this.readings.filter((r) => r.deviceId === this.selectedDeviceId);
    let filtered = [...source];

    const hasFrom = !!this.filterFrom?.trim();
    const hasTo = !!this.filterTo?.trim();

    if (hasFrom || hasTo) {
      if (hasFrom) {
        const fromMs = this.parseLocalDateLike(this.filterFrom)?.getTime() ?? Number.NaN;
        if (Number.isFinite(fromMs)) {
          filtered = filtered.filter((r) => new Date(r.at).getTime() >= fromMs);
        }
      }
      if (hasTo) {
        const parsedTo = this.parseLocalDateLike(this.filterTo);
        if (
          parsedTo &&
          parsedTo.getHours() === 0 &&
          parsedTo.getMinutes() === 0 &&
          parsedTo.getSeconds() === 0
        ) {
          parsedTo.setHours(23, 59, 59, 999);
        }
        const toMs = parsedTo?.getTime() ?? Number.NaN;
        if (Number.isFinite(toMs)) {
          filtered = filtered.filter((r) => new Date(r.at).getTime() <= toMs);
        }
      }
    } else if (this.filterDay) {
      const dayRange = this.parseDayRange(this.filterDay);
      if (dayRange) {
        const msStart = dayRange.from.getTime();
        const msEnd = dayRange.to.getTime();
        filtered = filtered.filter((r) => {
          const t = new Date(r.at).getTime();
          return Number.isFinite(t) && t >= msStart && t <= msEnd;
        });
      }
    }

    const sorted = filtered.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    if (sorted.length) {
      const windowed = this.hasUserDateFilter() ? sorted : sorted.slice(-48);
      return applyDisplayCap ? capChartPointsSorted(windowed) : windowed;
    }

    if (this.hasUserDateFilter()) {
      return [];
    }

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

  private hasUserDateFilter(): boolean {
    return !!this.filterDay?.trim() || !!this.filterFrom?.trim() || !!this.filterTo?.trim();
  }

  /** Rango por defecto en nube cuando no hay filtros (misma ventana que sugerimos en PDF). */
  private defaultCloudChartBounds(): { from: Date; to: Date } {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }

  /**
   * Límites que usa el gráfico: filtros del usuario o, en dispositivo nube, últimos 7 días en servidor.
   */
  private getEffectiveChartBounds(): { from: Date; to: Date } | null {
    const user = this.getUserDateFilterBounds();
    if (user) return user;
    if (
      !this.selectedDeviceId ||
      !this.deviceStore.isCloudSyncActive() ||
      !this.deviceStore.isCloudDeviceId(this.selectedDeviceId)
    ) {
      return null;
    }
    return this.defaultCloudChartBounds();
  }

  /** Límites solo si el usuario eligió día o rango (consulta Supabase). */
  private getUserDateFilterBounds(): { from: Date; to: Date } | null {
    const hasFrom = !!this.filterFrom?.trim();
    const hasTo = !!this.filterTo?.trim();
    /**
     * Desde/Hasta tienen prioridad sobre "Día": si ambos estaban llenos,
     * antes el día completo pisaba el rango horario (solo se veía efecto de "hasta").
     */
    if (hasFrom || hasTo) {
      let from: Date;
      let to: Date;

      if (hasFrom) {
        const parsed = this.parseLocalDateLike(this.filterFrom);
        if (!parsed) return null;
        from = parsed;
        if (!Number.isFinite(from.getTime())) return null;
      } else {
        from = new Date(0);
      }

      if (hasTo) {
        const parsed = this.parseLocalDateLike(this.filterTo);
        if (!parsed) return null;
        to = parsed;
        if (!Number.isFinite(to.getTime())) return null;
        if (to.getHours() === 0 && to.getMinutes() === 0 && to.getSeconds() === 0) {
          to.setHours(23, 59, 59, 999);
        }
      } else {
        to = new Date();
      }

      if (from > to) return null;
      return { from, to };
    }

    if (this.filterDay?.trim()) {
      const dayRange = this.parseDayRange(this.filterDay.trim());
      return dayRange ?? null;
    }

    return null;
  }

  /**
   * Acepta formato ISO (datetime-local/date) y fallback manual dd/mm/yyyy [hh:mm[:ss]].
   */
  private parseLocalDateLike(raw: string | null | undefined): Date | null {
    const v = (raw ?? '').trim();
    if (!v) return null;

    // Input date: yyyy-mm-dd (interpretar SIEMPRE en local para evitar desfase UTC).
    const ymd = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) {
      const year = Number(ymd[1]);
      const month = Number(ymd[2]);
      const day = Number(ymd[3]);
      const d = new Date(year, month - 1, day, 0, 0, 0, 0);
      if (!Number.isFinite(d.getTime())) return null;
      return d;
    }

    // Input datetime-local: yyyy-mm-ddTHH:mm[:ss] (también en local).
    const ymdHm = v.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
    );
    if (ymdHm) {
      const year = Number(ymdHm[1]);
      const month = Number(ymdHm[2]);
      const day = Number(ymdHm[3]);
      const hh = Number(ymdHm[4]);
      const mm = Number(ymdHm[5]);
      const ss = Number(ymdHm[6] ?? 0);
      const d = new Date(year, month - 1, day, hh, mm, ss, 0);
      if (!Number.isFinite(d.getTime())) return null;
      return d;
    }

    // Fallback para navegadores/locales que entregan dd/mm/yyyy hh:mm.
    const m = v.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/
    );
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      const year = Number(m[3]);
      const hh = Number(m[4] ?? 0);
      const mm = Number(m[5] ?? 0);
      const ss = Number(m[6] ?? 0);

      const d = new Date(year, month - 1, day, hh, mm, ss, 0);
      if (Number.isFinite(d.getTime())) return d;
    }

    // Fallback ultra tolerante:
    // soporta variantes locales con texto extra (ej: "26/03/2026 10:05 p. m.").
    // Formatos esperados en números:
    // - yyyy mm dd [hh mm ss]
    // - dd mm yyyy [hh mm ss]
    const nums = v.match(/\d+/g)?.map((n) => Number(n)) ?? [];
    if (nums.length >= 3) {
      let year = 0;
      let month = 0;
      let day = 0;
      let hh = 0;
      let mm = 0;
      let ss = 0;

      if (String(nums[0]).length === 4) {
        // yyyy-mm-dd ...
        year = nums[0];
        month = nums[1];
        day = nums[2];
        hh = nums[3] ?? 0;
        mm = nums[4] ?? 0;
        ss = nums[5] ?? 0;
      } else {
        // dd-mm-yyyy ...
        day = nums[0];
        month = nums[1];
        year = nums[2];
        hh = nums[3] ?? 0;
        mm = nums[4] ?? 0;
        ss = nums[5] ?? 0;
      }

      const lower = v.toLowerCase();
      const hasPm = /\bpm\b|p\.\s*m\b|p\.?\s*m\.?/i.test(lower);
      const hasAm = /\bam\b|a\.\s*m\b|a\.?\s*m\.?/i.test(lower);
      if (hasPm && hh >= 1 && hh <= 11) hh += 12;
      if (hasAm && hh === 12) hh = 0;

      const parsed = new Date(year, month - 1, day, hh, mm, ss, 0);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }

    return null;
  }

  private parseDayRange(rawDay: string): { from: Date; to: Date } | null {
    const d = this.parseLocalDateLike(rawDay);
    if (!d) return null;
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return { from, to };
  }

  private clearRemoteChartState(): void {
    this.remoteChartSeries = null;
    this.remoteChartLoading = false;
    this.remoteChartError = '';
  }

  /** Reintenta cargar el historial desde la nube tras un error de red o de API. */
  retryRemoteChartLoad(): void {
    this.scheduleRemoteChartLoad();
  }

  private scheduleRemoteChartLoad(): void {
    if (this.remoteLoadTimer != null) {
      clearTimeout(this.remoteLoadTimer);
    }
    const bounds = this.getEffectiveChartBounds();
    const deviceId = this.selectedDeviceId;
    if (
      !this.deviceStore.isCloudSyncActive() ||
      !bounds ||
      !deviceId ||
      !this.deviceStore.isCloudDeviceId(deviceId)
    ) {
      this.clearRemoteChartState();
      return;
    }
    this.remoteLoadGeneration++;
    const loadGen = this.remoteLoadGeneration;
    this.remoteChartLoading = true;
    this.remoteChartError = '';
    this.remoteChartSeries = null;
    this.remoteLoadTimer = window.setTimeout(() => {
      this.remoteLoadTimer = null;
      void this.loadRemoteChartSeries(loadGen);
    }, 400);
  }

  private async loadRemoteChartSeries(expectedGen: number): Promise<void> {
    const bounds = this.getEffectiveChartBounds();
    const deviceId = this.selectedDeviceId;
    if (
      !this.deviceStore.isCloudSyncActive() ||
      !bounds ||
      !deviceId ||
      !this.deviceStore.isCloudDeviceId(deviceId)
    ) {
      if (expectedGen === this.remoteLoadGeneration) {
        this.clearRemoteChartState();
      }
      return;
    }

    this.remoteChartError = '';
    try {
      const { rows, error } = await this.deviceStore.fetchChartReadingsForRange(
        deviceId,
        bounds.from.toISOString(),
        bounds.to.toISOString()
      );
      if (expectedGen !== this.remoteLoadGeneration) {
        return;
      }
      if (error) {
        this.remoteChartSeries = null;
        this.remoteChartError = error;
        return;
      }
      this.remoteChartSeries = rows;
      this.remoteChartError = '';
    } finally {
      if (expectedGen === this.remoteLoadGeneration) {
        this.remoteChartLoading = false;
      }
    }
  }

  private formatChartDateTime(iso: string, spanMs?: number): string {
    try {
      const d = new Date(iso);
      const span = spanMs ?? 86400000;
      const opts: Intl.DateTimeFormatOptions = {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      };
      if (span < 48 * 60 * 60 * 1000) {
        opts.second = '2-digit';
      }
      return d.toLocaleString('es-AR', opts);
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

  private calibrationFingerprint(d: DashboardDevice | undefined): string {
    if (!d) return '';
    const n = (v: number | null | undefined) =>
      v != null && Number.isFinite(v) ? String(v) : '0';
    return [
      n(d.temp1OffsetC),
      n(d.temp2OffsetC),
      n(d.temp3OffsetC),
      n(d.currentOffsetA),
      n(d.powerOffsetW),
    ].join('|');
  }

  toggleInformesPanel(): void {
    this.informesPanelOpen = !this.informesPanelOpen;
  }

  private loadInformesFromStorage(): void {
    try {
      const raw = localStorage.getItem(this.informesStorageKey);
      if (!raw) {
        this.informesList = [];
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        this.informesList = [];
        return;
      }
      this.informesList = parsed.filter(
        (x): x is StoredAnalysisInforme =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as StoredAnalysisInforme).id === 'string' &&
          typeof (x as StoredAnalysisInforme).title === 'string'
      );
      this.informesList.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    } catch {
      this.informesList = [];
    }
  }

  private persistInformesToStorage(): void {
    try {
      localStorage.setItem(this.informesStorageKey, JSON.stringify(this.informesList));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.informeFeedback = `No se pudo guardar la lista (${msg}).`;
      window.setTimeout(() => (this.informeFeedback = ''), 5000);
    }
  }

  formatInformeDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  onInformePhotoFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      this.informePhotoDataUrl = null;
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.informeFeedback = 'La imagen supera 2 MB. Elegí otra más liviana.';
      input.value = '';
      window.setTimeout(() => (this.informeFeedback = ''), 4000);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      this.informePhotoDataUrl = url;
      this.informeFeedback = '';
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  clearInformePhoto(): void {
    this.informePhotoDataUrl = null;
  }

  cancelInformeEditor(): void {
    this.informeEditorOpen = false;
    this.informeTitleForm = '';
    this.informeNoteForm = '';
    this.informePhotoDataUrl = null;
    this.informeFeedback = '';
  }

  saveInforme(): void {
    const title = this.informeTitleForm.trim();
    if (!title) {
      this.informeFeedback = 'Poné un título al informe.';
      window.setTimeout(() => (this.informeFeedback = ''), 4000);
      return;
    }
    if (!this.selectedDeviceId) {
      this.informeFeedback = 'Seleccioná un dispositivo.';
      window.setTimeout(() => (this.informeFeedback = ''), 4000);
      return;
    }
    const dev = this.devices.find((d) => d.id === this.selectedDeviceId);
    const row: StoredAnalysisInforme = {
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      createdAt: new Date().toISOString(),
      title,
      note: this.informeNoteForm.trim(),
      deviceId: this.selectedDeviceId,
      deviceName: dev?.name?.trim() || 'Equipo',
      filterFrom: this.filterFrom,
      filterTo: this.filterTo,
      filterDay: this.filterDay,
      seriesT1: this.seriesShowTemp1,
      seriesT2: this.seriesShowTemp2,
      seriesC: this.seriesShowCurrent,
      photoDataUrl: this.informePhotoDataUrl,
    };
    this.informesList = [row, ...this.informesList];
    this.persistInformesToStorage();
    this.informeTitleForm = '';
    this.informeNoteForm = '';
    this.informePhotoDataUrl = null;
    this.informeEditorOpen = false;
    this.informeFeedback = 'Informe guardado en este navegador.';
    window.setTimeout(() => (this.informeFeedback = ''), 4000);
  }

  deleteInforme(id: string): void {
    if (!confirm('¿Borrar este informe de la lista?')) return;
    this.informesList = this.informesList.filter((x) => x.id !== id);
    this.persistInformesToStorage();
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

  private delayPdf(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async downloadAnalysisPdf(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const deviceId = this.selectedDeviceId;
    if (!deviceId) {
      alert('Seleccioná un dispositivo para exportar.');
      return;
    }
    let rows = [...this.chartReadingsUncapped()].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
    );
    if (!rows.length) {
      alert('No hay lecturas en el rango del gráfico. Ajustá filtros o esperá datos.');
      return;
    }
    const rawLen = rows.length;
    rows = this.evenSamplePdfRows(rows, this.pdfTableMaxRows);
    let pdfNoteLine = '';
    if (rawLen > this.pdfTableMaxRows) {
      pdfNoteLine = `Tabla: muestreo uniforme (${this.pdfTableMaxRows} de ${rawLen} lecturas).`;
    }

    this.pdfExporting = true;
    this.hoverIndex = null;
    await this.delayPdf(60);

    let chartImgData: string | null = null;
    let chartImgW = 0;
    let chartImgH = 0;
    const captureEl = this.chartPdfCapture?.nativeElement;
    if (captureEl && this.hasChartData) {
      try {
        const html2canvas = (await import('html2canvas')).default;
        const canvas = await html2canvas(captureEl, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#0f172a',
          ignoreElements: (node: Element) => {
            if (!(node instanceof HTMLElement)) return false;
            return (
              node.classList.contains('chart-head__actions') ||
              node.classList.contains('chart-tooltip')
            );
          },
        });
        chartImgData = canvas.toDataURL('image/png');
        chartImgW = canvas.width;
        chartImgH = canvas.height;
      } catch {
        chartImgData = null;
      }
    }

    try {
      const [jspdfMod, { autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const JsPDF = jspdfMod.default;
      const device = this.selectedDevice;
      const name = device?.name ?? 'dispositivo';
      const s1 = this.sensor1Name;
      const s2 = this.sensor2Name;
      const has2 = rows.some((r) => r.temp2C != null && Number.isFinite(r.temp2C));
      const nomV = device?.nominalVoltageV;
      const hasCurrent = rows.some((r) => effectiveCurrentAWithNominal(r, nomV) != null);

      const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 14;

      const styleLabel =
        this.chartStyleOptions.find((o) => o.value === this.chartStylePreset)?.label ??
        this.chartStylePreset;

      doc.setFontSize(14);
      doc.text('AR Monitoreo — análisis (exportación)', 14, 16);
      doc.setFontSize(10);
      doc.text(`Dispositivo: ${name}`, 14, 23);
      doc.setFontSize(8);
      doc.setTextColor(80);
      const rangeLine = this.analysisPdfRangeLabel();
      const ch = this.analysisPdfSeriesLabel();
      let headerY = 28;
      doc.text(
        `Generado: ${new Date().toLocaleString('es-AR')} · ${rows.length} filas · ${rangeLine} · Series: ${ch} · Estilo: ${styleLabel}`,
        14,
        headerY
      );
      if (pdfNoteLine) {
        headerY += 5;
        doc.text(pdfNoteLine, 14, headerY);
        headerY += 2;
      }
      doc.setTextColor(0);

      let tableStartY = pdfNoteLine ? headerY + 4 : 34;

      if (chartImgData && chartImgW > 0 && chartImgH > 0) {
        doc.setFontSize(9);
        doc.text('Gráfico (misma vista que en pantalla, canal y zoom incluidos)', 14, tableStartY);
        tableStartY += 5;
        const maxW = pageW - 2 * margin;
        let dispW = maxW;
        let dispH = (chartImgH * dispW) / chartImgW;
        const room = pageH - tableStartY - 18;
        if (dispH > room && room > 25) {
          const r = room / dispH;
          dispH *= r;
          dispW *= r;
        }
        doc.addImage(chartImgData, 'PNG', margin, tableStartY, dispW, dispH);
        tableStartY += dispH + 8;
      }

      if (tableStartY > pageH - 45) {
        doc.addPage();
        tableStartY = 18;
      }

      doc.setFontSize(8);
      doc.setTextColor(80);
      doc.text('Tabla de valores numéricos', 14, tableStartY);
      doc.setTextColor(0);
      tableStartY += 4;

      const buildHead = (): string[][] => {
        const cols = ['Fecha y hora'];
        if (this.seriesShowTemp1) cols.push(`${s1} (°C)`);
        if (this.seriesShowTemp2 && has2) cols.push(`${s2} (°C)`);
        if (this.analysisShowsCurrent && hasCurrent) cols.push('Corriente (A)');
        return [cols];
      };
      const head = buildHead();
      const body: string[][] = rows.map((r) => {
        const row: string[] = [this.formatPdfDateTime(r.at)];
        if (this.seriesShowTemp1) row.push(r.temperatureC.toFixed(1));
        if (this.seriesShowTemp2 && has2) {
          row.push(
            r.temp2C != null && Number.isFinite(r.temp2C) ? r.temp2C.toFixed(1) : '—'
          );
        }
        if (this.analysisShowsCurrent && hasCurrent) {
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
      doc.save(`analisis_${safe}_${this.pdfDateStamp()}.pdf`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`No se pudo generar el PDF: ${msg}`);
    } finally {
      this.pdfExporting = false;
    }
  }

  private analysisPdfRangeLabel(): string {
    if (this.filterDay?.trim()) {
      return `día ${this.filterDay.trim()}`;
    }
    if (this.filterFrom?.trim() || this.filterTo?.trim()) {
      const a = this.filterFrom?.trim() || '…';
      const b = this.filterTo?.trim() || '…';
      return `desde ${a} hasta ${b}`;
    }
    if (
      this.selectedDeviceId &&
      this.deviceStore.isCloudSyncActive() &&
      this.deviceStore.isCloudDeviceId(this.selectedDeviceId)
    ) {
      return 'últimos 7 días (consulta nube)';
    }
    return 'ventana local del gráfico';
  }

  /** Etiqueta legible para PDF / cabecera según series visibles. */
  private analysisPdfSeriesLabel(): string {
    const parts: string[] = [];
    if (this.seriesShowTemp1) parts.push('Sensor 1');
    if (this.seriesShowTemp2 && this.hasSecondSeries) parts.push('Sensor 2');
    if (this.seriesShowCurrent) parts.push('Corriente');
    return parts.length ? parts.join(' + ') : '—';
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

  signOut(): void {
    void this.auth.signOut().then(() => void this.router.navigate(['/login']));
  }
}

