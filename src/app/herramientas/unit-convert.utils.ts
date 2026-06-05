import { ATM_BAR, PSI_PER_BAR } from './refrigerant-pt.utils';

export type UnitCategory = 'pressure' | 'temp' | 'power';

export type PressureConvertUnit = 'bar_g' | 'bar_a' | 'psi_g' | 'psi_a' | 'kpa_g';
export type TempConvertUnit = 'c' | 'f' | 'k';
export type PowerConvertUnit = 'kw' | 'tr' | 'hp' | 'btu_h';

const TR_TO_KW = 3.517;
const HP_TO_KW = 0.7457;
const BTU_H_TO_KW = 0.000293071;

export function pressureToBarG(value: number, unit: PressureConvertUnit): number | null {
  if (!Number.isFinite(value)) return null;
  switch (unit) {
    case 'bar_g':
      return value;
    case 'bar_a':
      return value - ATM_BAR;
    case 'psi_g':
      return value / PSI_PER_BAR;
    case 'psi_a':
      return value / PSI_PER_BAR - ATM_BAR;
    case 'kpa_g':
      return value / 100;
    default:
      return null;
  }
}

export function barGToPressure(valueBarG: number, unit: PressureConvertUnit): number | null {
  if (!Number.isFinite(valueBarG)) return null;
  switch (unit) {
    case 'bar_g':
      return valueBarG;
    case 'bar_a':
      return valueBarG + ATM_BAR;
    case 'psi_g':
      return valueBarG * PSI_PER_BAR;
    case 'psi_a':
      return (valueBarG + ATM_BAR) * PSI_PER_BAR;
    case 'kpa_g':
      return valueBarG * 100;
    default:
      return null;
  }
}

export function tempToC(value: number, unit: TempConvertUnit): number | null {
  if (!Number.isFinite(value)) return null;
  switch (unit) {
    case 'c':
      return value;
    case 'f':
      return ((value - 32) * 5) / 9;
    case 'k':
      return value - 273.15;
    default:
      return null;
  }
}

export function cToTemp(valueC: number, unit: TempConvertUnit): number | null {
  if (!Number.isFinite(valueC)) return null;
  switch (unit) {
    case 'c':
      return valueC;
    case 'f':
      return (valueC * 9) / 5 + 32;
    case 'k':
      return valueC + 273.15;
    default:
      return null;
  }
}

export function powerToKw(value: number, unit: PowerConvertUnit): number | null {
  if (!Number.isFinite(value)) return null;
  switch (unit) {
    case 'kw':
      return value;
    case 'tr':
      return value * TR_TO_KW;
    case 'hp':
      return value * HP_TO_KW;
    case 'btu_h':
      return value * BTU_H_TO_KW;
    default:
      return null;
  }
}

export function kwToPower(valueKw: number, unit: PowerConvertUnit): number | null {
  if (!Number.isFinite(valueKw)) return null;
  switch (unit) {
    case 'kw':
      return valueKw;
    case 'tr':
      return valueKw / TR_TO_KW;
    case 'hp':
      return valueKw / HP_TO_KW;
    case 'btu_h':
      return valueKw / BTU_H_TO_KW;
    default:
      return null;
  }
}

export const PRESSURE_UNIT_LABELS: Record<PressureConvertUnit, string> = {
  bar_g: 'bar g',
  bar_a: 'bar a',
  psi_g: 'psi g',
  psi_a: 'psi a',
  kpa_g: 'kPa g',
};

export const TEMP_UNIT_LABELS: Record<TempConvertUnit, string> = {
  c: '°C',
  f: '°F',
  k: 'K',
};

export const POWER_UNIT_LABELS: Record<PowerConvertUnit, string> = {
  kw: 'kW',
  tr: 'TR (ton)',
  hp: 'HP',
  btu_h: 'BTU/h',
};
