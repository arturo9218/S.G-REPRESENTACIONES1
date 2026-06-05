import type { Pro400FormModel } from './pro400-params.defaults';

export interface Pro400FieldMeta {
  key: keyof Pro400FormModel;
  code: string;
  label: string;
  help?: string;
}

export interface Pro400SectionMeta {
  id: string;
  title: string;
  intro?: string;
  fields: Pro400FieldMeta[];
}

export const PRO400_SECTIONS: Pro400SectionMeta[] = [
  {
    id: 'termo',
    title: 'Termostato',
    intro: 'AR01–AR06: consigna, corrección, límites y modo frío/calor.',
    fields: [
      { key: 'F01', code: 'AR01', label: 'Temperatura deseada (°C)', help: 'Consigna de control.' },
      { key: 'F02', code: 'AR02', label: 'Desplazamiento indicación (°C)', help: 'Corrección sumada a la sonda.' },
      { key: 'F03', code: 'AR03', label: 'Mínimo setpoint usuario (°C)' },
      { key: 'F04', code: 'AR04', label: 'Máximo setpoint usuario (°C)' },
      { key: 'F05', code: 'AR05', label: 'Diferencial (°C)', help: 'Histéresis de control.' },
      { key: 'F06', code: 'AR06', label: 'Modo (0=frío, 1=calor)' },
    ],
  },
  {
    id: 'comp',
    title: 'Tiempos compresor',
    fields: [
      { key: 'F07', code: 'AR07', label: 'Mínimo ON (s)' },
      { key: 'F08', code: 'AR08', label: 'Mínimo OFF (s)' },
    ],
  },
  {
    id: 'def',
    title: 'Deshielo',
    fields: [
      { key: 'F09', code: 'AR09', label: 'Intervalo refrigeración (min)' },
      { key: 'F10', code: 'AR10', label: 'Tiempo deshielo (min)' },
      { key: 'F11', code: 'AR11', label: 'Al encender (0=frío, 1=deshielo)' },
      { key: 'F12', code: 'AR12', label: 'Display trabado en deshielo (0/1)' },
    ],
  },
  {
    id: 'boot',
    title: 'Arranque',
    fields: [
      { key: 'F13', code: 'AR13', label: 'Retardo al energizar (min)' },
      { key: 'F14', code: 'AR14', label: 'Tiempo extra primer ciclo (min)' },
    ],
  },
  {
    id: 'sonda',
    title: 'Sonda y seguridad',
    fields: [
      { key: 'F15', code: 'AR15', label: 'Sonda fallada (0=apag, 1=ciclo, 2=ON)' },
      { key: 'F16', code: 'AR16', label: 'ON con error (min)' },
      { key: 'F17', code: 'AR17', label: 'OFF con error (min)' },
      { key: 'F18', code: 'AR18', label: 'Filtro digital (0–9)' },
    ],
  },
  {
    id: 'panel',
    title: 'Panel y nube',
    fields: [
      { key: 'F19', code: 'AR19', label: 'Bloqueo teclas (s)' },
      { key: 'F20', code: 'AR20', label: 'Desconexión funciones (0–2)' },
      { key: 'F21', code: 'AR21', label: 'Datalogger (2=nube)' },
      { key: 'F22', code: 'AR22', label: 'Intervalo muestras (s)' },
      { key: 'F23', code: 'AR23', label: 'ΔT envío forzado (°C)' },
      { key: 'F24', code: 'AR24', label: 'Cambio relé fuerza envío (0/1)' },
    ],
  },
  {
    id: 'dig',
    title: 'Entrada digital',
    fields: [
      { key: 'F26', code: 'AR26', label: 'Entrada digital (0=off, 1/2=puerta)' },
    ],
  },
  {
    id: 'hw',
    title: 'Hardware',
    intro: 'Un solo relé en la plaqueta (bit 5 del 4094). AR50 = inversión activo HIGH.',
    fields: [
      { key: 'F50', code: 'AR50', label: 'Inversión relé (0=LOW ON, 1=HIGH ON)' },
    ],
  },
];
