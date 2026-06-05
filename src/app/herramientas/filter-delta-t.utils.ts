export interface FilterDeltaTResult {
  deltaC: number;
  severity: 'ok' | 'warn' | 'critical';
  hint: string;
}

/** ΔT a través del filtro deshidratador (T entrada − T salida, líquido). */
export function evaluateFilterDeltaT(tempInC: number, tempOutC: number): FilterDeltaTResult | null {
  if (!Number.isFinite(tempInC) || !Number.isFinite(tempOutC)) return null;
  const delta = tempInC - tempOutC;
  if (delta < 0) {
    return {
      deltaC: delta,
      severity: 'warn',
      hint:
        'La salida está más fría que la entrada: revisá que las sondas estén bien colocadas (ambas en línea de líquido, después del condensador).',
    };
  }
  if (delta >= 3) {
    return {
      deltaC: delta,
      severity: 'critical',
      hint:
        'ΔT ≥ 3 °C: el filtro puede estar muy obstruido o con mucha restricción. Planificá reemplazo y revisá humedad en el circuito.',
    };
  }
  if (delta >= 1.5) {
    return {
      deltaC: delta,
      severity: 'warn',
      hint:
        'ΔT entre 1,5 y 3 °C: atención — puede indicar obstrucción incipiente o caída de presión. Controlá en la próxima visita.',
    };
  }
  return {
    deltaC: delta,
    severity: 'ok',
    hint: 'ΔT habitual para filtro en buen estado (< 1,5 °C en líquido).',
  };
}
