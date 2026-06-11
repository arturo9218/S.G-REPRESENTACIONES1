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
    intro: 'AR01–AR06: consigna, corrección de sonda, límites de ajuste y modo frío/calor.',
    fields: [
      {
        key: 'F01',
        code: 'AR01',
        label: 'Temperatura deseada (°C)',
        help: 'Consigna de control: el compresor trabaja para mantener la cámara cerca de este valor según el diferencial (AR05) y el modo frío/calor (AR06). En la app se cambia desde Configuración; en el equipo con el menú A01.',
      },
      {
        key: 'F02',
        code: 'AR02',
        label: 'Desplazamiento indicación (°C)',
        help: 'Corrección sumada a la lectura del NTC para que coincida con un termómetro de referencia en el mismo punto. Valor positivo sube lo que ves en pantalla y en la nube.',
      },
      {
        key: 'F03',
        code: 'AR03',
        label: 'Mínimo setpoint usuario (°C)',
        help: 'Límite inferior: ni en el menú del equipo ni en la app se puede bajar AR01 por debajo de este valor.',
      },
      {
        key: 'F04',
        code: 'AR04',
        label: 'Máximo setpoint usuario (°C)',
        help: 'Límite superior de AR01. Protege contra consignas fuera de rango operativo.',
      },
      {
        key: 'F05',
        code: 'AR05',
        label: 'Diferencial (°C)',
        help: 'Histéresis del termostato en modo frío: banda alrededor de AR01 para evitar ciclos muy cortos del compresor. En frío suele encender por debajo de (AR01 − AR05/2) y apagar al subir.',
      },
      {
        key: 'F06',
        code: 'AR06',
        label: 'Modo (0=frío, 1=calor)',
        help: '0 = frío (típico cámara): el compresor busca bajar temperatura. 1 = calor: la lógica de histéresis se invierte para aplicaciones de calefacción.',
      },
    ],
  },
  {
    id: 'comp',
    title: 'Tiempos compresor',
    intro: 'AR07–AR08: protección mecánica del compresor contra ciclos demasiado cortos.',
    fields: [
      {
        key: 'F07',
        code: 'AR07',
        label: 'Mínimo ON (s)',
        help: 'Una vez encendido, el compresor debe permanecer en marcha al menos este tiempo antes de que el control lo pueda apagar.',
      },
      {
        key: 'F08',
        code: 'AR08',
        label: 'Mínimo OFF (s)',
        help: 'Tras apagarse, el compresor no puede volver a encender hasta cumplir este tiempo apagado. Protege el motor y el contactor.',
      },
    ],
  },
  {
    id: 'def',
    title: 'Deshielo',
    intro: 'AR09–AR12: programación de deshielo y comportamiento del display. El PRO400 usa un solo relé (compresor/deshielo en la misma salida).',
    fields: [
      {
        key: 'F09',
        code: 'AR09',
        label: 'Intervalo refrigeración (min)',
        help: 'Minutos en régimen de frío tras terminar el goteo antes del próximo deshielo automático. No cuenta el tiempo de deshielo ni de goteo.',
      },
      {
        key: 'F10',
        code: 'AR10',
        label: 'Tiempo deshielo (min)',
        help: 'Duración máxima del deshielo. Al cumplirse pasa a goteo (unos 2 minutos con compresor apagado) y luego vuelve a frío.',
      },
      {
        key: 'F11',
        code: 'AR11',
        label: 'Al encender (0=frío, 1=deshielo)',
        help: '1 = al terminar el retardo de arranque (AR13) puede entrar en deshielo si corresponde. 0 = no forzar deshielo al boot.',
      },
      {
        key: 'F12',
        code: 'AR12',
        label: 'Display trabado en deshielo (0/1)',
        help: '1 = durante deshielo o goteo el display muestra la fase en curso en lugar de rotar vistas. 0 = podés cambiar vista con DOWN.',
      },
    ],
  },
  {
    id: 'boot',
    title: 'Arranque',
    intro: 'AR13–AR14: retardo al energizar y primer ciclo tras alimentación.',
    fields: [
      {
        key: 'F13',
        code: 'AR13',
        label: 'Retardo al energizar (min)',
        help: 'Tras encender el equipo los relés permanecen apagados al menos este tiempo (mínimo 10 s de hardware). Evita arranques bruscos tras corte de luz.',
      },
      {
        key: 'F14',
        code: 'AR14',
        label: 'Tiempo extra primer ciclo (min)',
        help: 'Suma minutos al intervalo de deshielo (AR09) en el primer ciclo tras alimentar, para dar margen de estabilización térmica.',
      },
    ],
  },
  {
    id: 'sonda',
    title: 'Sonda y seguridad',
    intro: 'AR15–AR18: comportamiento si la sonda NTC falla (cable roto, corto o lectura fuera de rango).',
    fields: [
      {
        key: 'F15',
        code: 'AR15',
        label: 'Sonda fallada (0=apag, 1=ciclo, 2=ON)',
        help: '0 = apaga compresor y queda en OFF. 1 = ciclo táctico ON/OFF según AR16 y AR17 (minutos). 2 = deja el relé encendido de forma continua (solo emergencia). Tras ~45 s de gracia al arranque aplica la acción elegida.',
      },
      {
        key: 'F16',
        code: 'AR16',
        label: 'ON con error (min)',
        help: 'Con AR15 = 1 (ciclo): minutos que el compresor queda forzado encendido en cada tramo del ciclo de emergencia por fallo de sonda.',
      },
      {
        key: 'F17',
        code: 'AR17',
        label: 'OFF con error (min)',
        help: 'Con AR15 = 1: minutos apagado entre cada tramo ON del ciclo de emergencia.',
      },
      {
        key: 'F18',
        code: 'AR18',
        label: 'Filtro digital (0–9)',
        help: 'Suavizado de la lectura (promedio exponencial). 0 = sin filtro, respuesta rápida. Valores altos = decimal más estable pero más lento ante cambios reales.',
      },
    ],
  },
  {
    id: 'panel',
    title: 'Panel y nube',
    intro: 'AR19–AR24: bloqueo de teclas, telemetría a la app y envío forzado.',
    fields: [
      {
        key: 'F19',
        code: 'AR19',
        label: 'Bloqueo teclas (s)',
        help: 'Segundos tras el arranque en que los botones no responden (salvo portal WiFi). 0 = sin bloqueo.',
      },
      {
        key: 'F20',
        code: 'AR20',
        label: 'Desconexión funciones (0–2)',
        help: '0 = normal (lee parámetros de la nube). 1 = no hace pull de parámetros desde la app. 2 = desactiva también el envío de telemetría.',
      },
      {
        key: 'F21',
        code: 'AR21',
        label: 'Datalogger (2=nube)',
        help: '0 = sin registro remoto. 1 = registro local. 2 = envía curva y estado a AR Monitoreo (recomendado). Con valor menor a 1 no hay telemetría.',
      },
      {
        key: 'F22',
        code: 'AR22',
        label: 'Intervalo muestras (s)',
        help: 'Cada cuántos segundos envía temperatura y estado a la nube cuando AR21 = 2. Mínimo 60 s.',
      },
      {
        key: 'F23',
        code: 'AR23',
        label: 'ΔT envío forzado (°C)',
        help: 'Si la temperatura cambia al menos este valor respecto del último envío, manda telemetría antes del intervalo AR22. 0 = solo por tiempo o cambio de relé.',
      },
      {
        key: 'F24',
        code: 'AR24',
        label: 'Cambio relé fuerza envío (0/1)',
        help: '1 = cada vez que cambia compresor, ventilador lógico o deshielo dispara un envío inmediato (con un mínimo de 5 s entre envíos forzados).',
      },
    ],
  },
  {
    id: 'dig',
    title: 'Entrada digital',
    intro: 'AR26: sensor de puerta opcional (requiere cableado en GPIO y habilitación en firmware).',
    fields: [
      {
        key: 'F26',
        code: 'AR26',
        label: 'Entrada digital (0=off, 1/2=puerta)',
        help: '0 = desactivada. 1 = puerta abierta con contacto a GND (activo en bajo). 2 = puerta abierta con contacto a +3,3 V (activo en alto). Si está activa, la telemetría incluye door_open.',
      },
    ],
  },
  {
    id: 'hw',
    title: 'Hardware',
    intro: 'AR50: polaridad del único relé en la plaqueta (bit 5 del segundo CD4094).',
    fields: [
      {
        key: 'F50',
        code: 'AR50',
        label: 'Inversión relé (0=LOW ON, 1=HIGH ON)',
        help: '0 = el relé energiza con salida en LOW (típico optoacoplador). 1 = invierte si tu placa o contactor es activo en HIGH. Ajustá solo si el compresor no arranca o queda pegado al revés.',
      },
    ],
  },
];
