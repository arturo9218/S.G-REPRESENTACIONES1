/**
 * PRO400 — parámetros F01–F26 (sin F25 ni F27), alineados al manual del controlador.
 * En la app se muestran como AR01…AR26; en el ESP como A01…A26.
 */
export const PRO400_DEFAULTS = {
  F01: 4,
  F02: 0,
  F03: -50,
  F04: 75,
  F05: 1,
  F06: 0,
  F07: 20,
  F08: 20,
  F09: 240,
  F10: 30,
  F11: 0,
  F12: 0,
  F13: 0,
  F14: 0,
  F15: 0,
  F16: 15,
  F17: 15,
  F18: 0,
  F19: 0,
  F20: 0,
  F21: 2,
  F22: 30,
  F23: 0,
  F24: 0,
  F26: 0,
  /** Inversión relés (hardware PRO300/400). */
  F50: 0,
};

export type Pro400FormModel = { [K in keyof typeof PRO400_DEFAULTS]: number };

const KEYS = Object.keys(PRO400_DEFAULTS) as (keyof Pro400FormModel)[];

export function mergePro400Params(db: unknown): Pro400FormModel {
  const base = { ...PRO400_DEFAULTS } as Pro400FormModel;
  if (!db || typeof db !== 'object') return base;
  const o = db as Record<string, unknown>;
  for (const k of KEYS) {
    if (!(k in o)) continue;
    const v = o[k as string];
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) base[k] = n;
  }
  return base;
}

export function pro400ToJsonBlob(m: Pro400FormModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KEYS) out[k as string] = m[k];
  return out;
}

/** Código AR en UI (01…24, 26 — sin 25 ni 27). */
export const PRO400_AR_CODES = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '26',
] as const;

export const PRO400_AR_TO_F: Record<string, keyof Pro400FormModel> = {
  '01': 'F01', '02': 'F02', '03': 'F03', '04': 'F04', '05': 'F05',
  '06': 'F06', '07': 'F07', '08': 'F08', '09': 'F09', '10': 'F10',
  '11': 'F11', '12': 'F12', '13': 'F13', '14': 'F14', '15': 'F15',
  '16': 'F16', '17': 'F17', '18': 'F18', '19': 'F19', '20': 'F20',
  '21': 'F21', '22': 'F22', '23': 'F23', '24': 'F24', '26': 'F26',
};
