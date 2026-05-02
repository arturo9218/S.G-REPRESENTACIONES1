import type { Pr500FormModel } from './pr500-params.defaults';

export type Pr500Field = { key: keyof Pr500FormModel; label: string; help?: string; step?: number };

export type Pr500Section = { id: string; title: string; intro?: string; fields: Pr500Field[] };

/** Nombre visible: F1…F9 sin cero a la izquierda; F10 en adelante igual que la clave. */
function fLabel(key: keyof Pr500FormModel): string {
  const s = String(key);
  const m = /^F0([1-9])$/.exec(s);
  if (m) return `F${m[1]}`;
  return s;
}

export const PR500_SECTIONS: Pr500Section[] = [
  {
    id: 'f01-f08',
    title: 'Parámetros F1 a F8',
    intro: 'Marcha general, presión, tiempos entre arranques y rotación. Van en el mismo orden que en el equipo.',
    fields: [
      {
        key: 'F01',
        label: `${fLabel('F01')} · Marcha del automático`,
        help: '0 = todo apagado por relés. 1 = el control puede encender y apagar compresores según la presión y los tiempos.',
        step: 1,
      },
      {
        key: 'F02',
        label: `${fLabel('F02')} · Presión de trabajo deseada`,
        help: 'Valor central al que querés que tienda la instalación (en la unidad que elegís más abajo, bar o psi).',
        step: 0.01,
      },
      {
        key: 'F03',
        label: `${fLabel('F03')} · Banda o margen general`,
        help: 'Cuánto puede moverse la presión alrededor del valor central antes de pedir más o menos potencia. Más alto suaviza; más bajo reacciona más rápido.',
        step: 0.01,
      },
      {
        key: 'F04',
        label: `${fLabel('F04')} · Separación entre compresores`,
        help: 'Cuanto más alto, más separado queda el punto en que entra el segundo respecto del primero, y el tercero respecto del segundo.',
        step: 0.01,
      },
      {
        key: 'F05',
        label: `${fLabel('F05')} · Pausa entre arranques`,
        help: 'Segundos mínimos entre el arranque de un compresor y el del siguiente. Reduce picos de corriente.',
        step: 1,
      },
      {
        key: 'F06',
        label: `${fLabel('F06')} · Tiempo mínimo apagado`,
        help: 'Segundos apagado antes de permitir volver a arrancar. Evita encendidos seguidos.',
        step: 1,
      },
      {
        key: 'F07',
        label: `${fLabel('F07')} · Tiempo mínimo encendido`,
        help: 'Segundos encendido antes de permitir apagarlo. Evita ciclos cortos.',
        step: 1,
      },
      {
        key: 'F08',
        label: `${fLabel('F08')} · Rotación cada tantas horas`,
        help: '0 = no rota. Si ponés horas, con el tiempo cambia qué compresor actúa como el primero, cuando ninguno está en marcha.',
        step: 1,
      },
    ],
  },
  {
    id: 'f09-f16',
    title: 'Parámetros F9 a F16',
    intro: 'Cantidad de máquinas, alarmas de presión, corrección del sensor y unidad de medida.',
    fields: [
      {
        key: 'F09',
        label: `${fLabel('F09')} · Cuántos compresores usás`,
        help: '1, 2 o 3. Solo esas etapas entran en el automático.',
        step: 1,
      },
      {
        key: 'F10',
        label: `${fLabel('F10')} · Presión muy baja (alarma)`,
        help: 'En cero, no hay alarma por baja. Con un valor, no debe quedar la presión debajo demasiado tiempo (ver el tiempo siguiente).',
        step: 0.01,
      },
      {
        key: 'F11',
        label: `${fLabel('F11')} · Presión muy alta (alarma)`,
        help: 'En cero, no hay alarma por alta. Con un valor, no debe quedar por encima demasiado tiempo.',
        step: 0.01,
      },
      {
        key: 'F12',
        label: `${fLabel('F12')} · Segundos que tolera la baja`,
        help: 'Tiempo seguido por debajo del umbral de baja antes de disparar la alarma.',
        step: 1,
      },
      {
        key: 'F13',
        label: `${fLabel('F13')} · Segundos que tolera el exceso`,
        help: 'Tiempo seguido por encima del umbral de alta antes de disparar la alarma.',
        step: 1,
      },
      {
        key: 'F14',
        label: `${fLabel('F14')} · Corrección del manómetro`,
        help: 'Si la lectura no coincide con un manómetro de confianza en el mismo punto, ajustá hasta que coincidan (misma unidad que elegís abajo).',
        step: 0.01,
      },
      {
        key: 'F15',
        label: `${fLabel('F15')} · Unidad (bar o psi)`,
        help: '0 = bar. 1 = psi. Al cambiar, los valores de presión se convierten para mantener la misma presión física. En la nube la medición sigue en bar; la app puede mostrar psi.',
        step: 1,
      },
      {
        key: 'F16',
        label: `${fLabel('F16')} · Borrar alarma`,
        help: 'Poné 1 y guardá para quitar el bloqueo de alarma cuando ya revisaste la causa. El equipo lo vuelve a cero al aplicar.',
        step: 1,
      },
    ],
  },
  {
    id: 'f17-f22',
    title: 'Parámetros F17 a F22',
    intro: 'Manual por compresor, datos de taller y modo de reacción de la presión.',
    fields: [
      {
        key: 'F17',
        label: `${fLabel('F17')} · Forzar compresor 1`,
        help: '1 = encendido forzado del primer relé si la marcha general está en 1. 0 = automático.',
        step: 1,
      },
      {
        key: 'F18',
        label: `${fLabel('F18')} · Forzar compresor 2`,
        help: 'Igual que el anterior, para el segundo compresor.',
        step: 1,
      },
      {
        key: 'F19',
        label: `${fLabel('F19')} · Forzar compresor 3`,
        help: 'Igual que el anterior, para el tercer compresor.',
        step: 1,
      },
      {
        key: 'F20',
        label: `${fLabel('F20')} · Nota de versión`,
        help: 'Número libre para identificar la puesta a punto en taller; no cambia el comportamiento.',
        step: 1,
      },
      {
        key: 'F21',
        label: `${fLabel('F21')} · Reservado`,
        help: 'Guardado para un uso futuro; hoy no cambia el funcionamiento.',
        step: 1,
      },
      {
        key: 'F22',
        label: `${fLabel('F22')} · Cómo reacciona la presión`,
        help: '0: la etapa suele entrar si la presión cae (banda clásica). 1: la etapa entra si la presión sube (demanda) y apaga al volver al valor de trabajo.',
        step: 1,
      },
    ],
  },
  {
    id: 'f23-f27',
    title: 'Fallo de sensor de presión (F23 a F27)',
    intro:
      'Si la tensión del ADC sale de la ventana F26–F27 (voltios en el pin), el equipo trata falla de cable/sensor (con F23≠0), alarma y ciclo ON/OFF F24/F25. Ajustá F26/F27 si tu transductor no usa 0,08–3,22 V. F16 borra la alarma como el resto.',
    fields: [
      {
        key: 'F23',
        label: `${fLabel('F23')} · Confirmación de falla (s)`,
        help: '0 = no usar detección por tensión. Si es mayor que 0: segundos seguidos con señal inválida antes de disparar alarma “sensor” y el ciclo de emergencia (mínimo 5 s si no es 0).',
        step: 1,
      },
      {
        key: 'F24',
        label: `${fLabel('F24')} · Tiempo encendido en emergencia (s)`,
        help: 'Con fallo de sensor confirmado, cuántos segundos quedan encendidos juntos los compresores según F09 (10…7200).',
        step: 1,
      },
      {
        key: 'F25',
        label: `${fLabel('F25')} · Tiempo apagado en emergencia (s)`,
        help: 'Segundos apagados entre ciclos en ese mismo modo (10…7200).',
        step: 1,
      },
      {
        key: 'F26',
        label: `${fLabel('F26')} · Tensión mínima válida (V)`,
        help: 'Por debajo de este valor en el ADC (0…3,25 V) la señal se considera inválida. Debe quedar al menos 0,05 V por debajo de F27.',
        step: 0.01,
      },
      {
        key: 'F27',
        label: `${fLabel('F27')} · Tensión máxima válida (V)`,
        help: 'Por encima de este valor (0,05…3,3 V) se considera inválida. Típico cable suelto hacia +3,3 V.',
        step: 0.01,
      },
    ],
  },
];
