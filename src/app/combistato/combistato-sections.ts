import type { CombistatoFormModel } from './combistato-params.defaults';

export interface CombistatoFieldMeta {
  key: keyof CombistatoFormModel;
  label: string;
  step?: number;
}

export interface CombistatoSectionMeta {
  id: string;
  title: string;
  fields: CombistatoFieldMeta[];
}

export const COMBISTATO_SECTIONS: CombistatoSectionMeta[] = [
  {
    id: 'temp',
    title: 'Temperatura y control',
    fields: [
      { key: 'F01', label: 'F01 Setpoint SP (°C)', step: 0.1 },
      { key: 'F02', label: 'F02 Diferencial / histéresis (K)', step: 0.1 },
      { key: 'F03', label: 'F03 Corrección S1 (°C)', step: 0.1 },
      { key: 'F04', label: 'F04 Corrección S2 (°C)', step: 0.1 },
      { key: 'F53', label: 'F53 Sonda control (0=S1, 1=S2)' },
      { key: 'F54', label: 'F54 Muestras promedio ADC (1–32)' },
      { key: 'F49', label: 'F49 Modo (0=frío, 1=calor)' },
      { key: 'F50', label: 'F50 Inversión relé compresor (0/1)' },
    ],
  },
  {
    id: 'defrost',
    title: 'Deshielo',
    fields: [
      { key: 'F05', label: 'F05 Tipo (0=resistencia, 1=gas caliente)' },
      { key: 'F06', label: 'F06 Intervalo entre deshielos (min)' },
      { key: 'F07', label: 'F07 Tiempo máx. deshielo (min)' },
      { key: 'F08', label: 'F08 Temp. fin deshielo S2 (°C)', step: 0.1 },
      { key: 'F09', label: 'F09 Deshielo al encender (0/1)' },
      { key: 'F38', label: 'F38 Retardo al encender (s)' },
      { key: 'F39', label: 'F39 Tiempo de goteo (min)' },
      { key: 'F45', label: 'F45 Bloqueo deshielo al encender (min)' },
      { key: 'F46', label: 'F46 Máx. sin deshielo → forzar (min)' },
      { key: 'F52', label: 'F52 Deshielo por temp. (0/1)' },
      { key: 'F52t', label: 'F52t Umbral hielo evaporador (°C)', step: 0.1 },
    ],
  },
  {
    id: 'fan',
    title: 'Ventilador',
    fields: [
      { key: 'F10', label: 'F10 Ventilador en deshielo (0/1)' },
      { key: 'F11', label: 'F11 Retardo vent. post-deshielo (min)' },
      { key: 'F12', label: 'F12 Temp. evap. para ventilador (°C)', step: 0.1 },
      { key: 'F51', label: 'F51 Ventilador continuo (0/1)' },
    ],
  },
  {
    id: 'alarms',
    title: 'Alarmas',
    fields: [
      { key: 'F13', label: 'F13 Alarma alta (°C)', step: 0.1 },
      { key: 'F14', label: 'F14 Alarma baja (°C)', step: 0.1 },
      { key: 'F15', label: 'F15 Retardo alarma (min)' },
      { key: 'F16', label: 'F16 Alarma sonda (0/1)' },
      { key: 'F47', label: 'F47 Histéresis alarma (K)', step: 0.1 },
      { key: 'F48', label: 'F48 Retardo alarmas al encender (min)' },
    ],
  },
  {
    id: 'compressor',
    title: 'Compresor y emergencia',
    fields: [
      { key: 'F17', label: 'F17 Tiempo mín. apagado (s)' },
      { key: 'F18', label: 'F18 Tiempo mín. encendido (s)' },
      { key: 'F19', label: 'F19 Emergencia — tiempo ON (s)' },
      { key: 'F20', label: 'F20 Emergencia — tiempo OFF (s)' },
      { key: 'F55', label: 'F55 Falla sonda → emergencia (0/1)' },
    ],
  },
  {
    id: 'door',
    title: 'Puerta',
    fields: [
      { key: 'F25', label: 'F25 Habilitar entrada puerta (0/1)' },
      { key: 'F26', label: 'F26 Contacto (0=NA, 1=NC)' },
      { key: 'F27', label: 'F27 Retardo alarma puerta (s)' },
      { key: 'F28', label: 'F28 Apagar ventilador con puerta (0/1)' },
      { key: 'F29', label: 'F29 Bloquear alarma térmica con puerta (0/1)' },
      { key: 'F30', label: 'F30 Registrar evento puerta por Serial (0/1)' },
      { key: 'F40', label: 'F40 Apagar compresor con puerta (0/1)' },
    ],
  },
  {
    id: 'manual',
    title: 'Manual / técnico (firmware)',
    fields: [
      { key: 'F31', label: 'F31 Permitir compresor manual Serial (0/1)' },
      { key: 'F32', label: 'F32 Tiempo máx. compresor manual (min)' },
      { key: 'F33', label: 'F33 Permitir ventilador manual Serial (0/1)' },
      { key: 'F34', label: 'F34 Tiempo ventilador manual (min)' },
      { key: 'F35', label: 'F35 Permitir deshielo manual Serial (0/1)' },
      { key: 'F36', label: 'F36 Tiempo entre deshielos manual (min)' },
      { key: 'F37', label: 'F37 Deshielo inmediato (0/1)' },
    ],
  },
];
