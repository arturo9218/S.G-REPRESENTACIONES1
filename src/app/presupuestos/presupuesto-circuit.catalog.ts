import type { ComponentStatus, RefrigerationSystemType } from './presupuesto-circuit.models';

export const SYSTEM_TYPE_OPTIONS: { id: RefrigerationSystemType; label: string; hint: string }[] = [
  { id: 'camara', label: 'Cámara frigorífica', hint: 'Cámara positiva / negativa, túnel, depósito' },
  { id: 'heladera', label: 'Heladera / mueble', hint: 'Vertical, horizontal, vitrina, mostrador' },
  { id: 'central_frigorifica', label: 'Central frigorífica', hint: 'Rack, múltiples evaporadores, planta' },
  { id: 'chiller', label: 'Chiller', hint: 'Agua helada / glicol, enfriador de procesos' },
  { id: 'banco_agua_helada', label: 'Banco de agua helada', hint: 'Bomba, intercambiador, acumulador' },
  { id: 'otro', label: 'Otro', hint: 'Describir en el campo adicional' },
];

export const COMPONENT_STATUS_OPTIONS: { id: ComponentStatus; label: string }[] = [
  { id: 'ok', label: 'OK' },
  { id: 'falla', label: 'Falla' },
  { id: 'revisar', label: 'A revisar' },
  { id: 'reemplazar', label: 'A reemplazar' },
  { id: 'na', label: 'N/A' },
];

export interface CircuitComponentDef {
  key: string;
  label: string;
}

export interface CircuitSectionDef {
  key: string;
  title: string;
  subtitle: string;
  components: CircuitComponentDef[];
}

/** Secciones del circuito frigorífico para relevamiento técnico. */
export const CIRCUIT_SECTION_DEFS: CircuitSectionDef[] = [
  {
    key: 'evaporador',
    title: 'Evaporador',
    subtitle: 'Lado baja presión — serpentín, forzador, expansión, deshielo',
    components: [
      { key: 'serpentin_evap', label: 'Serpentín evaporador' },
      { key: 'forzador_evap', label: 'Forzador / ventilador evaporador' },
      { key: 'valvula_expansion', label: 'Válvula de expansión (TXV / EEV)' },
      { key: 'tobera_capilar', label: 'Tobera / capilar' },
      { key: 'solenoide', label: 'Válvula solenoide' },
      { key: 'filtro_deshidratador_baja', label: 'Filtro deshidratador (succión / líquido)' },
      { key: 'acumulador_succion', label: 'Acumulador de succión' },
      { key: 'deshielo', label: 'Sistema de deshielo (resistencias / gas caliente)' },
      { key: 'sonda_evap', label: 'Sonda / termostato evaporador' },
      { key: 'puerta_burlete', label: 'Puerta, burlete, bandejas (si aplica)' },
    ],
  },
  {
    key: 'condensador_compresor',
    title: 'Condensador y motocompresor',
    subtitle: 'Lado alta presión — compresor, descarga, condensación',
    components: [
      { key: 'motocompresor', label: 'Motocompresor / compresor' },
      { key: 'tipo_compresor', label: 'Tipo (scroll / semihermético / reciprocante / inverter)' },
      { key: 'arranque_rele', label: 'Arranque, relé, capacitor' },
      { key: 'proteccion_termica', label: 'Protección térmica / KPI / INT' },
      { key: 'serpentin_cond', label: 'Serpentín condensador' },
      { key: 'ventilador_cond', label: 'Ventilador condensador' },
      { key: 'valvula_descarga', label: 'Válvula de descarga / regla' },
      { key: 'separador_aceite', label: 'Separador de aceite' },
      { key: 'recuperador_liquido', label: 'Recuperador / receiver' },
      { key: 'valvula_retencion', label: 'Válvula de retención / check' },
      { key: 'filtro_alta', label: 'Filtro deshidratador línea líquido' },
    ],
  },
  {
    key: 'lineas_accesorios',
    title: 'Líneas y accesorios',
    subtitle: 'Tubería, aislamiento, vacío, carga, controles',
    components: [
      { key: 'linea_succion', label: 'Línea de succión (aislamiento / pendiente)' },
      { key: 'linea_liquido', label: 'Línea de líquido' },
      { key: 'linea_descarga', label: 'Línea de descarga' },
      { key: 'vacuum_carga', label: 'Vacío y carga de refrigerante' },
      { key: 'tablero_control', label: 'Tablero / control / variador' },
      { key: 'alarmas_seguridad', label: 'Alarmas LP / HP / nivel aceite' },
      { key: 'bomba_agua', label: 'Bomba de agua / glicol (chiller / banco)' },
      { key: 'intercambiador', label: 'Intercambiador / placa' },
    ],
  },
];

export function systemTypeLabel(id: RefrigerationSystemType | '' | null, other?: string): string {
  if (!id) return '—';
  const found = SYSTEM_TYPE_OPTIONS.find((o) => o.id === id);
  if (id === 'otro' && other?.trim()) return other.trim();
  return found?.label ?? id;
}
