import type { DataloggerFormModel } from './datalogger-params.defaults';

export type DataloggerOffsets = {
  temp1C: number;
  temp2C: number;
  temp3C: number;
  temp4C: number;
  temp5C: number;
  temp6C: number;
  current1A: number;
  current2A: number;
  current3A: number;
  power1W: number;
  power2W: number;
  power3W: number;
  press1Bar: number;
  press2Bar: number;
};

export const DATALOGGER_OFFSET_FIELD_MAP: {
  rawKey: string;
  corrKey: string;
  offsetKey: keyof DataloggerFormModel;
}[] = [
  { rawKey: 'temp1_raw_c', corrKey: 'temp1_c', offsetKey: 'F35' },
  { rawKey: 'temp2_raw_c', corrKey: 'temp2_c', offsetKey: 'F36' },
  { rawKey: 'temp3_raw_c', corrKey: 'temp3_c', offsetKey: 'F37' },
  { rawKey: 'temp4_raw_c', corrKey: 'temp4_c', offsetKey: 'F38' },
  { rawKey: 'temp5_raw_c', corrKey: 'temp5_c', offsetKey: 'F39' },
  { rawKey: 'temp6_raw_c', corrKey: 'temp6_c', offsetKey: 'F40' },
  { rawKey: 'current1_raw_a', corrKey: 'current1_a', offsetKey: 'F41' },
  { rawKey: 'current2_raw_a', corrKey: 'current2_a', offsetKey: 'F42' },
  { rawKey: 'current3_raw_a', corrKey: 'current3_a', offsetKey: 'F43' },
  { rawKey: 'power1_raw_w', corrKey: 'power1_w', offsetKey: 'F44' },
  { rawKey: 'power2_raw_w', corrKey: 'power2_w', offsetKey: 'F45' },
  { rawKey: 'power3_raw_w', corrKey: 'power3_w', offsetKey: 'F46' },
  { rawKey: 'press1_raw_bar', corrKey: 'press1_bar', offsetKey: 'F47' },
  { rawKey: 'press2_raw_bar', corrKey: 'press2_bar', offsetKey: 'F48' },
];

export function normalizeDataloggerOffset(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function dataloggerOffsetsFromParams(m: DataloggerFormModel): DataloggerOffsets {
  return {
    temp1C: normalizeDataloggerOffset(m.F35),
    temp2C: normalizeDataloggerOffset(m.F36),
    temp3C: normalizeDataloggerOffset(m.F37),
    temp4C: normalizeDataloggerOffset(m.F38),
    temp5C: normalizeDataloggerOffset(m.F39),
    temp6C: normalizeDataloggerOffset(m.F40),
    current1A: normalizeDataloggerOffset(m.F41),
    current2A: normalizeDataloggerOffset(m.F42),
    current3A: normalizeDataloggerOffset(m.F43),
    power1W: normalizeDataloggerOffset(m.F44),
    power2W: normalizeDataloggerOffset(m.F45),
    power3W: normalizeDataloggerOffset(m.F46),
    press1Bar: normalizeDataloggerOffset(m.F47),
    press2Bar: normalizeDataloggerOffset(m.F48),
  };
}

export function offsetForField(
  offsets: DataloggerOffsets,
  offsetKey: keyof DataloggerFormModel
): number {
  const map: Record<string, number> = {
    F35: offsets.temp1C,
    F36: offsets.temp2C,
    F37: offsets.temp3C,
    F38: offsets.temp4C,
    F39: offsets.temp5C,
    F40: offsets.temp6C,
    F41: offsets.current1A,
    F42: offsets.current2A,
    F43: offsets.current3A,
    F44: offsets.power1W,
    F45: offsets.power2W,
    F46: offsets.power3W,
    F47: offsets.press1Bar,
    F48: offsets.press2Bar,
  };
  return map[offsetKey as string] ?? 0;
}

export function applyDataloggerOffset(raw: number | null | undefined, off: number): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return raw + off;
}

/** Aplica offsets actuales; si no hay columna raw, usa el valor guardado tal cual. */
export function correctDataloggerReadingRow(
  row: Record<string, unknown>,
  params: DataloggerFormModel
): Record<string, number | null> {
  const offsets = dataloggerOffsetsFromParams(params);
  const out: Record<string, number | null> = {};
  for (const f of DATALOGGER_OFFSET_FIELD_MAP) {
    const raw = row[f.rawKey];
    const corr = row[f.corrKey];
    const off = offsetForField(offsets, f.offsetKey);
    const rawN =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : typeof corr === 'number' && Number.isFinite(corr)
          ? corr
          : null;
    out[f.corrKey] =
      typeof raw === 'number' && Number.isFinite(raw)
        ? applyDataloggerOffset(raw, off)
        : typeof corr === 'number' && Number.isFinite(corr)
          ? corr
          : null;
    if (rawN != null) out[f.rawKey] = rawN;
  }
  return out;
}
