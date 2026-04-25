import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { environment } from '../../environments/environment';
import { isSupabaseConfigured } from '../core/supabase-config';

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

  pressurePath = '';
  /** Polígono bajo la curva (relleno suave en el SVG). */
  pressureAreaPath = '';
  pMin = 0;
  pMax = 6;
  timeLabels: { x: number; text: string }[] = [];

  private sub?: Subscription;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly auth: AuthService
  ) {}

  ngOnInit(): void {
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

  backToApp(): void {
    void this.router.navigate(['/dashboard']);
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
        .select('name')
        .eq('id', this.pr500Id)
        .maybeSingle();
      if (eMeta) {
        this.error = eMeta.message;
        return;
      }
      this.pr500Name = (meta as { name?: string } | null)?.name?.trim() || 'PR500';

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
        .select(
          'id, pr500_id, created_at, pressure_bar, comp1_on, comp2_on, comp3_on, alarm_on, di1_ok, di2_ok, di3_ok, di4_ok'
        )
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
    void this.loadAll();
  }

  private rebuildChartGeometry(): void {
    const pts = this.displayPoints;
    if (pts.length === 0) {
      this.pressurePath = '';
      this.pressureAreaPath = '';
      this.timeLabels = [];
      return;
    }
    const t0 = new Date(pts[0].created_at).getTime();
    const t1 = new Date(pts[pts.length - 1].created_at).getTime();
    const span = Math.max(t1 - t0, 60_000);
    const xAt = (iso: string) => {
      const tx = new Date(iso).getTime();
      return ((tx - t0) / span) * 100;
    };
    let minP = Infinity;
    let maxP = -Infinity;
    for (const p of pts) {
      if (Number.isFinite(p.pressure_bar)) {
        minP = Math.min(minP, p.pressure_bar);
        maxP = Math.max(maxP, p.pressure_bar);
      }
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
      minP = 0;
      maxP = 4;
    }
    const pad = Math.max((maxP - minP) * 0.08, 0.05);
    this.pMin = minP - pad;
    this.pMax = maxP + pad;
    const yAt = (bar: number) => {
      const r = this.pMax - this.pMin || 1;
      return 100 - ((bar - this.pMin) / r) * 100;
    };
    const parts: string[] = [];
    let firstX = 0;
    let lastX = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = xAt(p.created_at);
      const y = yAt(p.pressure_bar);
      if (i === 0) firstX = x;
      lastX = x;
      parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
    }
    this.pressurePath = parts.join(' ');
    this.pressureAreaPath = `${this.pressurePath} L${lastX.toFixed(2)},100 L${firstX.toFixed(2)},100 Z`;
    this.timeLabels = [
      { x: 0, text: new Date(pts[0].created_at).toLocaleString('es-AR', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) },
      {
        x: 100,
        text: new Date(pts[pts.length - 1].created_at).toLocaleString('es-AR', {
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
    ];
  }

  lastRowSummary(): string {
    const r = this.readings.length ? this.readings[this.readings.length - 1] : null;
    if (!r) return 'Sin datos en el rango.';
    const di = (v: boolean | null | undefined) =>
      v === null || v === undefined ? '—' : v ? 'OK' : 'FALLO';
    return (
      `Presión: ${r.pressure_bar.toFixed(2)} bar · C1 ${r.comp1_on ? 'ON' : 'OFF'} · C2 ${r.comp2_on ? 'ON' : 'OFF'} · C3 ${
        r.comp3_on ? 'ON' : 'OFF'
      } · Alarma ${r.alarm_on ? 'SÍ' : 'no'} · DI ${di(r.di1_ok)}/${di(r.di2_ok)}/${di(r.di3_ok)}/${di(r.di4_ok)}`
    );
  }
}
