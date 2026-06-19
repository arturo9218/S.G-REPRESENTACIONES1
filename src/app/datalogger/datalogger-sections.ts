import type { DataloggerFormModel } from './datalogger-params.defaults';

export type DataloggerField = {
  key: keyof DataloggerFormModel;
  code: string;
  label: string;
  help?: string;
  step?: number;
  input?: 'text' | 'sct-scale' | 'on-off';
};

export type DataloggerSection = { id: string; title: string; intro?: string; fields: DataloggerField[] };

export const DATALOGGER_SECTIONS: DataloggerSection[] = [
  {
    id: 'channels-temp',
    title: 'Temperatura (6 sondas)',
    intro:
      'Canales T1–T6 definidos de fábrica. AR24–AR29: 1 = leer sonda, 0 = apagado (el canal queda reservado en el equipo).',
    fields: [
      {
        key: 'F24',
        code: 'AR24',
        label: 'T1 — temperatura',
        input: 'on-off',
        help: 'Habilita la sonda NTC del canal 1. Con 0 el Datalogger no lee ni envía temp1_c.',
      },
      {
        key: 'F25',
        code: 'AR25',
        label: 'T2 — temperatura',
        input: 'on-off',
        help: 'Canal 2 de temperatura. Útil para ambiente vs producto o dos puntos de la instalación.',
      },
      {
        key: 'F26',
        code: 'AR26',
        label: 'T3 — temperatura',
        input: 'on-off',
        help: 'Canal 3. Activá solo los canales cableados para no enviar lecturas vacías.',
      },
      {
        key: 'F27',
        code: 'AR27',
        label: 'T4 — temperatura',
        input: 'on-off',
        help: 'Canal 4 de temperatura.',
      },
      {
        key: 'F28',
        code: 'AR28',
        label: 'T5 — temperatura',
        input: 'on-off',
        help: 'Canal 5 de temperatura.',
      },
      {
        key: 'F29',
        code: 'AR29',
        label: 'T6 — temperatura',
        input: 'on-off',
        help: 'Canal 6 de temperatura.',
      },
    ],
  },
  {
    id: 'channels-power',
    title: 'Consumo / corriente (3 canales)',
    intro:
      'Canales C1–C3 para módulo SCT. AR30–AR32 habilitan cada pinza. AR21–AR23: escala del jumper. AR14: tensión de línea para calcular vatios (no es presión).',
    fields: [
      {
        key: 'F30',
        code: 'AR30',
        label: 'C1 — corriente',
        input: 'on-off',
        help: 'Pinza SCT canal 1. Con 1 el equipo calcula corriente y potencia (W = AR14 × A).',
      },
      {
        key: 'F31',
        code: 'AR31',
        label: 'C2 — corriente',
        input: 'on-off',
        help: 'Pinza SCT canal 2.',
      },
      {
        key: 'F32',
        code: 'AR32',
        label: 'C3 — corriente',
        input: 'on-off',
        help: 'Pinza SCT canal 3.',
      },
      {
        key: 'F21',
        code: 'AR21',
        label: 'Escala SCT C1',
        help: 'Amperes por 1 V de salida del módulo SCT-013 (jumper 10/20/30/50/60). Tras cambiar: guardar y sincronizar con el Datalogger (comando pull).',
        input: 'sct-scale',
      },
      {
        key: 'F22',
        code: 'AR22',
        label: 'Escala SCT C2',
        help: 'Escala del módulo SCT del canal 2. Debe coincidir con el jumper físico del módulo.',
        input: 'sct-scale',
      },
      {
        key: 'F23',
        code: 'AR23',
        label: 'Escala SCT C3',
        help: 'Escala del módulo SCT del canal 3.',
        input: 'sct-scale',
      },
      {
        key: 'F14',
        code: 'AR14',
        label: 'Tensión línea (V)',
        help: 'Solo consumo: potencia W = AR14 × amperes RMS. Ej. 220 monofásico, 380 entre fases. No es presión.',
        step: 1,
      },
    ],
  },
  {
    id: 'channels-press',
    title: 'Presión (2 sensores)',
    intro: 'Canales P1–P2 para transductor 4–20 mA (igual PR500). AR33–AR34: 1 = activo, 0 = apagado.',
    fields: [
      {
        key: 'F33',
        code: 'AR33',
        label: 'P1 — presión',
        input: 'on-off',
        help: 'Transductor 4-20 mA con 150 ohm: 0,5 a 8 bar (misma formula que PR500). Mismo cableado que PR500.',
      },
      {
        key: 'F34',
        code: 'AR34',
        label: 'P2 — presión',
        input: 'on-off',
        help: 'Segundo transductor de presión. Activá solo si está cableado.',
      },
    ],
  },
  {
    id: 'calibration',
    title: 'Correcciones (offset)',
    intro:
      'Sumá o restá al valor que envía el equipo. La tarjeta y el gráfico muestran bruto + corrección. Si la sonda marca 2 °C de más, poné −2 en la temperatura correspondiente.',
    fields: [
      {
        key: 'F35',
        code: 'AR35',
        label: 'Offset T1 (°C)',
        step: 0.1,
        help: 'Corrección en °C al valor bruto de T1 antes de guardar y mostrar.',
      },
      {
        key: 'F36',
        code: 'AR36',
        label: 'Offset T2 (°C)',
        step: 0.1,
        help: 'Corrección T2. Las lecturas viejas se recalculan en pantalla con el offset actual.',
      },
      {
        key: 'F37',
        code: 'AR37',
        label: 'Offset T3 (°C)',
        step: 0.1,
        help: 'Corrección T3.',
      },
      {
        key: 'F38',
        code: 'AR38',
        label: 'Offset T4 (°C)',
        step: 0.1,
        help: 'Corrección T4.',
      },
      {
        key: 'F39',
        code: 'AR39',
        label: 'Offset T5 (°C)',
        step: 0.1,
        help: 'Corrección T5.',
      },
      {
        key: 'F40',
        code: 'AR40',
        label: 'Offset T6 (°C)',
        step: 0.1,
        help: 'Corrección T6.',
      },
      {
        key: 'F41',
        code: 'AR41',
        label: 'Offset C1 corriente (A)',
        step: 0.01,
        help: 'Suma en amperes al RMS del canal 1. Ajustá esto si la pinza lee alto/bajo de forma sistemática.',
      },
      {
        key: 'F42',
        code: 'AR42',
        label: 'Offset C2 corriente (A)',
        step: 0.01,
        help: 'Corrección de corriente canal 2.',
      },
      {
        key: 'F43',
        code: 'AR43',
        label: 'Offset C3 corriente (A)',
        step: 0.01,
        help: 'Corrección de corriente canal 3.',
      },
      {
        key: 'F44',
        code: 'AR44',
        label: 'Offset C1 potencia (W)',
        step: 1,
        help: 'Corrección en vatios canal 1. Preferí ajustar AR41 y AR14 antes que la potencia directamente.',
      },
      {
        key: 'F45',
        code: 'AR45',
        label: 'Offset C2 potencia (W)',
        step: 1,
        help: 'Corrección potencia canal 2.',
      },
      {
        key: 'F46',
        code: 'AR46',
        label: 'Offset C3 potencia (W)',
        step: 1,
        help: 'Corrección potencia canal 3.',
      },
      {
        key: 'F47',
        code: 'AR47',
        label: 'Offset P1 presión (bar)',
        step: 0.01,
        help: 'Suma en bar al transductor P1. Si el manómetro marca 0,2 bar de más, poné −0,2.',
      },
      {
        key: 'F48',
        code: 'AR48',
        label: 'Offset P2 presión (bar)',
        step: 0.01,
        help: 'Corrección presión canal 2.',
      },
    ],
  },
  {
    id: 'telemetry',
    title: 'Telemetría y red',
    fields: [
      {
        key: 'F12',
        code: 'AR12',
        label: 'Intervalo de envío (s)',
        help: 'Cada cuántos segundos el Datalogger sube lecturas a la nube (mínimo práctico ~15 s).',
        step: 1,
      },
      {
        key: 'F13',
        code: 'AR13',
        label: 'Subir a nube',
        help: '0 = solo registro local. 1 = envío automático a la nube con moduleId y deviceToken.',
        input: 'on-off',
      },
    ],
  },
  {
    id: 'alarms',
    title: 'Alarmas (push)',
    intro: 'Umbrales orientativos; el Datalogger y la app los usan para avisos.',
    fields: [
      {
        key: 'F15',
        code: 'AR15',
        label: 'T1 mínima (°C)',
        step: 0.1,
        help: 'Alarma si T1 corregida queda por debajo. Dejá un valor muy bajo si no querés aviso por mínimo.',
      },
      {
        key: 'F16',
        code: 'AR16',
        label: 'T1 máxima (°C)',
        step: 0.1,
        help: 'Alarma si T1 supera este valor (cámara caliente, falla de frío, etc.).',
      },
      {
        key: 'F17',
        code: 'AR17',
        label: 'T2 mínima (°C)',
        step: 0.1,
        help: 'Umbral bajo para T2.',
      },
      {
        key: 'F18',
        code: 'AR18',
        label: 'T2 máxima (°C)',
        step: 0.1,
        help: 'Umbral alto para T2.',
      },
      {
        key: 'F19',
        code: 'AR19',
        label: 'C1 corriente máx (A)',
        help: '0 = sin límite. Si la corriente corregida supera este valor, aviso de consumo.',
        step: 0.1,
      },
      {
        key: 'F20',
        code: 'AR20',
        label: 'P1 presión máx (bar)',
        help: '0 = sin límite. Protección por sobrepresión en P1.',
        step: 0.01,
      },
    ],
  },
];
