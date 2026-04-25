import type { Pr500FormModel } from './pr500-params.defaults';

export type Pr500Field = { key: keyof Pr500FormModel; label: string; step?: number };

export type Pr500Section = { id: string; title: string; fields: Pr500Field[] };

export const PR500_SECTIONS: Pr500Section[] = [
  {
    id: 'access',
    title: 'Acceso',
    fields: [{ key: 'F01', label: 'F01 · Código de acceso', step: 1 }],
  },
  {
    id: 'pressure',
    title: 'Presión y etapas',
    fields: [
      { key: 'F02', label: 'F02 · Setpoint presión (bar)', step: 0.01 },
      { key: 'F03', label: 'F03 · Diferencial general (bar)', step: 0.01 },
      { key: 'F04', label: 'F04 · Diferencial entre etapas (bar)', step: 0.01 },
      { key: 'F09', label: 'F09 · Modo: 1, 2 o 3 compresores', step: 1 },
      { key: 'F15', label: 'F15 · Unidad (0=bar, 1=psi)', step: 1 },
      { key: 'F14', label: 'F14 · Calibración sensor', step: 0.01 },
    ],
  },
  {
    id: 'times',
    title: 'Tiempos y rotación',
    fields: [
      { key: 'F05', label: 'F05 · Retardo entre arranques (s)', step: 1 },
      { key: 'F06', label: 'F06 · Retardo mínimo apagado (s)', step: 1 },
      { key: 'F07', label: 'F07 · Tiempo mínimo encendido (s)', step: 1 },
      { key: 'F08', label: 'F08 · Rotación compresores (h)', step: 1 },
    ],
  },
  {
    id: 'safety',
    title: 'Seguridad y alarmas',
    fields: [
      { key: 'F10', label: 'F10 · Presión mínima seguridad (bar)', step: 0.01 },
      { key: 'F11', label: 'F11 · Presión máxima seguridad (bar)', step: 0.01 },
      { key: 'F12', label: 'F12 · Tiempo alarma baja presión (s)', step: 1 },
      { key: 'F13', label: 'F13 · Tiempo alarma alta presión (s)', step: 1 },
      { key: 'F16', label: 'F16 · Reset alarma (0/1)', step: 1 },
    ],
  },
  {
    id: 'manual',
    title: 'Manual / diagnóstico',
    fields: [
      { key: 'F17', label: 'F17 · Manual compresor 1 (0/1)', step: 1 },
      { key: 'F18', label: 'F18 · Manual compresor 2 (0/1)', step: 1 },
      { key: 'F19', label: 'F19 · Manual compresor 3 (0/1)', step: 1 },
      { key: 'F20', label: 'F20 · Versión firmware (info)', step: 1 },
      { key: 'F21', label: 'F21 · OTA habilitado (0/1)', step: 1 },
    ],
  },
];
