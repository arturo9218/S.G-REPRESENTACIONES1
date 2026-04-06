import { capChartPointsSorted, CHART_DISPLAY_MAX_POINTS } from './chart-sampling';
import type { TemperatureReading } from './models/dashboard.models';

function makeSeries(n: number): TemperatureReading[] {
  const base = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    deviceId: 'd1',
    at: new Date(base + i * 60_000).toISOString(),
    temperatureC: 20 + i * 0.01,
  }));
}

describe('capChartPointsSorted', () => {
  it('no recorta si hay pocos puntos', () => {
    const s = makeSeries(10);
    expect(capChartPointsSorted(s, 8000)).toBe(s);
    expect(capChartPointsSorted(s, 8000).length).toBe(10);
  });

  it('recorta a cap y conserva primer y último punto', () => {
    const s = makeSeries(100);
    const out = capChartPointsSorted(s, 20);
    expect(out.length).toBe(20);
    expect(out[0]).toBe(s[0]);
    expect(out[19]).toBe(s[99]);
  });

  it('usa CHART_DISPLAY_MAX_POINTS por defecto', () => {
    const s = makeSeries(CHART_DISPLAY_MAX_POINTS + 500);
    const out = capChartPointsSorted(s);
    expect(out.length).toBe(CHART_DISPLAY_MAX_POINTS);
  });
});
