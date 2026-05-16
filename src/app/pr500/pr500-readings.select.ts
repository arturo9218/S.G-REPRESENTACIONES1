/**
 * Columnas PostgREST para `pr500_readings` (evita `select('*')`: menos egress y JSON más chico).
 * Mantener alineado con `Pr500ReadingRow` y migraciones 037–039 + run_ms (038).
 */
export const PR500_READINGS_POSTGREST_COLUMNS =
  'id, pr500_id, created_at, pressure_bar, comp1_on, comp2_on, comp3_on, alarm_on, di1_ok, di2_ok, di3_ok, di4_ok, comp1_run_ms, comp2_run_ms, comp3_run_ms, temp_suction_c, superheat_c, superheat_ok';
