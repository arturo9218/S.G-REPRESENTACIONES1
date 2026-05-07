import type { Pr500FormModel } from './pr500-params.defaults';

/** `code`: referencia amigable en la app. `key`: lo que guarda el firmware (F01…). */
export type Pr500Field = {
  key: keyof Pr500FormModel;
  code: string;
  label: string;
  help?: string;
  step?: number;
};

export type Pr500Section = { id: string; title: string; intro?: string; fields: Pr500Field[] };

export const PR500_SECTIONS: Pr500Section[] = [
  {
    id: 'f01-f08',
    title: 'Bloque 1 · Marcha, presión y tiempos',
    intro: 'Códigos AR01–AR08 y AR28 (reparto entre compresores): orden de uso habitual para ajuste diario.',
    fields: [
      {
        key: 'F01',
        code: 'AR01',
        label: 'Marcha del automático',
        help: '0 = todo apagado por relés. 1 = el control puede encender y apagar compresores según la presión y los tiempos.',
        step: 1,
      },
      {
        key: 'F02',
        code: 'AR02',
        label: 'Presión de trabajo (setpoint)',
        help: 'Valor central al que querés que tienda la instalación (en la unidad que elegís más abajo, bar o psi).',
        step: 0.01,
      },
      {
        key: 'F03',
        code: 'AR03',
        label: 'Banda o margen general',
        help: 'Cuánto puede moverse la presión alrededor del valor central antes de pedir más o menos potencia. Más alto suaviza; más bajo reacciona más rápido.',
        step: 0.01,
      },
      {
        key: 'F04',
        code: 'AR04',
        label: 'Separación entre compresores',
        help: 'Cuanto más alto, más separado queda el punto en que entra el segundo respecto del primero, y el tercero respecto del segundo.',
        step: 0.01,
      },
      {
        key: 'F05',
        code: 'AR05',
        label: 'Pausa entre arranques',
        help: 'Segundos mínimos entre el arranque de un compresor y el del siguiente. Reduce picos de corriente.',
        step: 1,
      },
      {
        key: 'F06',
        code: 'AR06',
        label: 'Tiempo mínimo apagado',
        help: 'Segundos apagado antes de permitir volver a arrancar. Evita encendidos seguidos.',
        step: 1,
      },
      {
        key: 'F07',
        code: 'AR07',
        label: 'Tiempo mínimo encendido',
        help: 'Segundos encendido antes de permitir apagarlo. Evita ciclos cortos.',
        step: 1,
      },
      {
        key: 'F08',
        code: 'AR08',
        label: 'Rotación cada tantas horas',
        help: '0 = no rota. Si ponés horas, con el tiempo cambia qué compresor actúa como el primero, cuando ninguno está en marcha.',
        step: 1,
      },
      {
        key: 'F28',
        code: 'AR28',
        label: 'Balanceo por horas de marcha',
        help: '0 = reparto por rotación AR08 (lead). 1 = el equipo elige los compresores con menor tiempo ON acumulado; AR08 entonces no define esa asignación (firmware Stage3 con horómetro en flash).',
        step: 1,
      },
    ],
  },
  {
    id: 'f09-f16',
    title: 'Bloque 2 · Etapas, alarmas y unidad',
    intro: 'AR09–AR16: cantidad de máquinas, umbrales de alarma, corrección del sensor y unidad bar/psi.',
    fields: [
      {
        key: 'F09',
        code: 'AR09',
        label: 'Cantidad de compresores',
        help: '1, 2 o 3. Solo esas etapas entran en el automático.',
        step: 1,
      },
      {
        key: 'F10',
        code: 'AR10',
        label: 'Alarma presión muy baja',
        help: 'En cero, no hay alarma por baja. Con un valor, no debe quedar la presión debajo demasiado tiempo (ver tiempo AR12).',
        step: 0.01,
      },
      {
        key: 'F11',
        code: 'AR11',
        label: 'Alarma presión muy alta',
        help: 'En cero, no hay alarma por alta. Con un valor, no debe quedar por encima demasiado tiempo (ver AR13).',
        step: 0.01,
      },
      {
        key: 'F12',
        code: 'AR12',
        label: 'Tolerancia alarma baja (s)',
        help: 'Tiempo seguido por debajo del umbral de baja antes de disparar la alarma.',
        step: 1,
      },
      {
        key: 'F13',
        code: 'AR13',
        label: 'Tolerancia alarma alta (s)',
        help: 'Tiempo seguido por encima del umbral de alta antes de disparar la alarma.',
        step: 1,
      },
      {
        key: 'F14',
        code: 'AR14',
        label: 'Corrección del manómetro',
        help: 'Si la lectura no coincide con un manómetro de confianza en el mismo punto, ajustá hasta que coincidan (misma unidad que elegís abajo).',
        step: 0.01,
      },
      {
        key: 'F15',
        code: 'AR15',
        label: 'Unidad (0 = bar, 1 = psi)',
        help: 'Al cambiar, los valores de presión se convierten para mantener la misma presión física. En la nube la medición sigue en bar; la app puede mostrar psi.',
        step: 1,
      },
      {
        key: 'F16',
        code: 'AR16',
        label: 'Borrar alarma',
        help: 'Poné 1 y guardá para quitar el bloqueo de alarma cuando ya revisaste la causa. El equipo lo vuelve a cero al aplicar.',
        step: 1,
      },
    ],
  },
  {
    id: 'f17-f22',
    title: 'Bloque 3 · Forzados y modo de regulación',
    intro: 'AR17–AR22: manuales por relé, dato de taller y lógica baja/alta presión.',
    fields: [
      {
        key: 'F17',
        code: 'AR17',
        label: 'Forzar compresor 1',
        help: '1 = encendido forzado del primer relé si la marcha general (AR01) está en 1. 0 = automático.',
        step: 1,
      },
      {
        key: 'F18',
        code: 'AR18',
        label: 'Forzar compresor 2',
        help: 'Igual que AR17, para el segundo compresor.',
        step: 1,
      },
      {
        key: 'F19',
        code: 'AR19',
        label: 'Forzar compresor 3',
        help: 'Igual que AR17, para el tercer compresor.',
        step: 1,
      },
      {
        key: 'F20',
        code: 'AR20',
        label: 'Nota de versión / taller',
        help: 'Número libre para identificar la puesta a punto en taller; no cambia el comportamiento.',
        step: 1,
      },
      {
        key: 'F21',
        code: 'AR21',
        label: 'Reservado',
        help: 'Guardado para un uso futuro; hoy no cambia el funcionamiento.',
        step: 1,
      },
      {
        key: 'F22',
        code: 'AR22',
        label: 'Modo de reacción a la presión',
        help: '0: la etapa suele entrar si la presión cae (banda clásica). 1: la etapa entra si la presión sube (demanda) y apaga al volver al valor de trabajo.',
        step: 1,
      },
    ],
  },
  {
    id: 'f23-f27',
    title: 'Bloque 4 · Fallo del sensor de presión (ADC)',
    intro:
      'AR23–AR27: si la tensión del ADC sale de la ventana AR26–AR27 (voltios en el pin), el equipo trata falla de cable/sensor (con AR23≠0), alarma y ciclo ON/OFF AR24/AR25. AR16 borra la alarma como el resto.',
    fields: [
      {
        key: 'F23',
        code: 'AR23',
        label: 'Confirmación de fallo (s)',
        help: '0 = no usar detección por tensión. Si es mayor que 0: segundos seguidos con señal inválida antes de disparar alarma “sensor” y el ciclo de emergencia (mínimo 5 s si no es 0).',
        step: 1,
      },
      {
        key: 'F24',
        code: 'AR24',
        label: 'Emergencia — tiempo encendido (s)',
        help: 'Con fallo de sensor confirmado, cuántos segundos quedan encendidos juntos los compresores según AR09 (10…7200).',
        step: 1,
      },
      {
        key: 'F25',
        code: 'AR25',
        label: 'Emergencia — tiempo apagado (s)',
        help: 'Segundos apagados entre ciclos en ese mismo modo (10…7200).',
        step: 1,
      },
      {
        key: 'F26',
        code: 'AR26',
        label: 'Tensión mínima válida (V)',
        help: 'Por debajo de este valor en el ADC (0…3,25 V) la señal se considera inválida. Debe quedar al menos 0,05 V por debajo de AR27.',
        step: 0.01,
      },
      {
        key: 'F27',
        code: 'AR27',
        label: 'Tensión máxima válida (V)',
        help: 'Por encima de este valor (0,05…3,3 V) se considera inválida. Típico cable suelto hacia +3,3 V.',
        step: 0.01,
      },
    ],
  },
];
