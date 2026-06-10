import type { CombistatoFormModel } from './combistato-params.defaults';

/** `code`: referencia en la app (ARxx). `key`: clave en firmware y JSON (F01…, F52t). */
export interface CombistatoFieldMeta {
  key: keyof CombistatoFormModel;
  code: string;
  label: string;
  help?: string;
  step?: number;
}

export interface CombistatoSectionMeta {
  id: string;
  title: string;
  intro?: string;
  fields: CombistatoFieldMeta[];
}

export const COMBISTATO_SECTIONS: CombistatoSectionMeta[] = [
  {
    id: 'temp',
    title: 'Temperatura y control',
    intro: 'AR01–AR08: setpoint, histéresis, corrección de sondas y opciones de lectura.',
    fields: [
      {
        key: 'F01',
        code: 'AR01',
        label: 'Setpoint SP (°C)',
        help: 'Temperatura objetivo de la cámara o evaporador según el modo frío/calor.',
        step: 0.1,
      },
      {
        key: 'F02',
        code: 'AR02',
        label: 'Diferencial / histéresis (K)',
        help: 'Banda alrededor del setpoint: evita que el compresor corte y arranque en cada pequeña oscilación.',
        step: 0.1,
      },
      {
        key: 'F03',
        code: 'AR03',
        label: 'Corrección sonda S1 (°C)',
        help: 'Suma (o resta) este valor a la lectura del NTC en GPIO 34 para calibrar contra un termómetro de referencia.',
        step: 0.1,
      },
      {
        key: 'F04',
        code: 'AR04',
        label: 'Corrección sonda S2 (°C)',
        help: 'Igual que AR03 para la segunda sonda (GPIO 35), usada como evaporador o respaldo según AR07.',
        step: 0.1,
      },
      {
        key: 'F49',
        code: 'AR05',
        label: 'Modo frío / calor',
        help: '0 = frío (típico cámara): compresor para bajar temperatura. 1 = calor: la lógica de histéresis se invierte.',
        step: 1,
      },
      {
        key: 'F50',
        code: 'AR06',
        label: 'Inversión relé compresor',
        help: '0 = relé activo en HIGH como salida “encendido”. 1 = invierte la polaridad si tu placa es activo en bajo.',
        step: 1,
      },
      {
        key: 'F53',
        code: 'AR07',
        label: 'Sonda que manda el termostato',
        help: '0 = control por temperatura de S1. 1 = control por S2. La otra sonda sigue leyéndose para alarmas y deshielo.',
        step: 1,
      },
      {
        key: 'F54',
        code: 'AR08',
        label: 'Muestras promedio ADC',
        help: 'Lecturas ADC que se promedian en cada toma (4–32). Más muestras = decimal más estable. El equipo además promedia las últimas 8 lecturas (1/s) en pantalla.',
        step: 1,
      },
    ],
  },
  {
    id: 'defrost',
    title: 'Deshielo',
    intro: 'AR09–AR19: tipo, tiempos, fin por temperatura en S2 y protecciones.',
    fields: [
      {
        key: 'F05',
        code: 'AR09',
        label: 'Tipo de deshielo',
        help: '0 = resistencia en el relé de deshielo. 1 = gas caliente (segundo relé si está cableado en firmware).',
        step: 1,
      },
      {
        key: 'F06',
        code: 'AR10',
        label: 'Intervalo entre deshielos (min)',
        help: 'Minutos en refrigeración tras terminar el goteo (AR15) antes del próximo deshielo. No incluye deshielo ni goteo.',
        step: 1,
      },
      {
        key: 'F07',
        code: 'AR11',
        label: 'Tiempo máximo de deshielo (min)',
        help: 'Corte de seguridad: aunque no llegue la temperatura de fin, corta el deshielo tras este tiempo.',
        step: 1,
      },
      {
        key: 'F08',
        code: 'AR12',
        label: 'Temperatura fin deshielo en S2 (°C)',
        help: 'Cuando el evaporador (sonda S2) supera este valor, se considera deshielado y pasa a goteo.',
        step: 0.1,
      },
      {
        key: 'F09',
        code: 'AR13',
        label: 'Deshielo al encender',
        help: '1 = al terminar el retardo de arranque puede entrar en deshielo si corresponde. 0 = no forzar al boot.',
        step: 1,
      },
      {
        key: 'F38',
        code: 'AR14',
        label: 'Retardo al encender (s)',
        help: 'Tras alimentar el equipo no arranca el control normal hasta pasar estos segundos (arranque en frío).',
        step: 1,
      },
      {
        key: 'F39',
        code: 'AR15',
        label: 'Tiempo de goteo (min)',
        help: 'Tras cortar resistencia/gas, espera con compresor y ventilador según lógica antes de volver a frío.',
        step: 1,
      },
      {
        key: 'F45',
        code: 'AR16',
        label: 'Bloqueo deshielo al arranque (min)',
        help: 'Desde que termina el retardo de arranque, no se permite deshielo programado hasta pasar estos minutos.',
        step: 1,
      },
      {
        key: 'F46',
        code: 'AR17',
        label: 'Máximo sin deshielo → forzar (min)',
        help: 'Si no hubo deshielo en este tiempo, fuerza uno para evitar hielo excesivo en evaporador.',
        step: 1,
      },
      {
        key: 'F52',
        code: 'AR18',
        label: 'Deshielo por temperatura (habilitar)',
        help: '1 = además del reloj, puede pedir deshielo si la S2 indica hielo por debajo de AR19.',
        step: 1,
      },
      {
        key: 'F52t',
        code: 'AR19',
        label: 'Umbral “hielo” evaporador (°C)',
        help: 'Usado con AR18: si la temperatura S2 está por debajo de este valor, se interpreta necesidad de deshielo.',
        step: 0.1,
      },
    ],
  },
  {
    id: 'fan',
    title: 'Ventilador',
    intro: 'AR20–AR23: comportamiento del forzador en deshielo y en régimen.',
    fields: [
      {
        key: 'F10',
        code: 'AR20',
        label: 'Ventilador durante deshielo',
        help: '1 = el ventilador puede estar según etapa de deshielo. 0 = no forzar encendido en deshielo.',
        step: 1,
      },
      {
        key: 'F11',
        code: 'AR21',
        label: 'Retardo ventilador post-deshielo (min)',
        help: 'Tras terminar el deshielo/goteo, espera antes de volver a encender el ventilador automático.',
        step: 1,
      },
      {
        key: 'F12',
        code: 'AR22',
        label: 'Temperatura evap. para ventilador (°C)',
        help: 'Condición típica: no ventilar el evaporador hasta que suba de este valor tras deshielo (evita soplar humedad).',
        step: 0.1,
      },
      {
        key: 'F51',
        code: 'AR23',
        label: 'Ventilador continuo',
        help: '1 = mantiene el ventilador en marcha en régimen normal salvo bloqueos (puerta, fase, etc.). 0 = según lógica térmica.',
        step: 1,
      },
    ],
  },
  {
    id: 'alarms',
    title: 'Alarmas térmicas',
    intro: 'AR24–AR29: límites de temperatura y retardos.',
    fields: [
      {
        key: 'F13',
        code: 'AR24',
        label: 'Alarma temperatura alta (°C)',
        help: 'Si la temperatura de control supera este valor el tiempo AR26, se dispara alarma alta.',
        step: 0.1,
      },
      {
        key: 'F14',
        code: 'AR25',
        label: 'Alarma temperatura baja (°C)',
        help: 'Si la temperatura de control cae por debajo de este valor el tiempo AR26, alarma baja.',
        step: 0.1,
      },
      {
        key: 'F15',
        code: 'AR26',
        label: 'Retardo antes de alarma térmica (min)',
        help: 'Tiempo que la condición de alta o baja debe mantenerse antes de hacer latch de alarma.',
        step: 1,
      },
      {
        key: 'F16',
        code: 'AR27',
        label: 'Alarma por fallo de sonda',
        help: '1 = habilita tratamiento de fallo de lectura NTC (cable roto, corto). 0 = ignorar para alarmas de sonda.',
        step: 1,
      },
      {
        key: 'F47',
        code: 'AR28',
        label: 'Histéresis de alarma (K)',
        help: 'Banda para borrar la condición de alarma sin fluctuar en el umbral.',
        step: 0.1,
      },
      {
        key: 'F48',
        code: 'AR29',
        label: 'Retardo alarmas al encender (min)',
        help: 'Tras el arranque, no evalúa alarmas térmicas hasta pasar este tiempo (evita falsas alarmas al estabilizar).',
        step: 1,
      },
    ],
  },
  {
    id: 'compressor',
    title: 'Compresor y emergencia por sonda',
    intro: 'AR30–AR34: tiempos mínimos de marcha y ciclo de emergencia si falla la sonda.',
    fields: [
      {
        key: 'F17',
        code: 'AR30',
        label: 'Tiempo mínimo apagado compresor (s)',
        help: 'Protección mecánica: no permite reencender el compresor hasta que lleve al menos este tiempo apagado.',
        step: 1,
      },
      {
        key: 'F18',
        code: 'AR31',
        label: 'Tiempo mínimo encendido compresor (s)',
        help: 'No permite apagar el compresor hasta cumplir este tiempo en marcha (evita ciclos cortos).',
        step: 1,
      },
      {
        key: 'F19',
        code: 'AR32',
        label: 'Emergencia — tiempo ON (s)',
        help: 'Con fallo de sonda y AR34 activo: segundos que el compresor queda forzado encendido en el ciclo táctico.',
        step: 1,
      },
      {
        key: 'F20',
        code: 'AR33',
        label: 'Emergencia — tiempo OFF (s)',
        help: 'Segundos apagado entre pulsos de emergencia cuando hay fallo de sonda.',
        step: 1,
      },
      {
        key: 'F55',
        code: 'AR34',
        label: 'Falla sonda → emergencia cíclica',
        help: '1 = ante fallo de la sonda de control (o ambas si aplica), entra en ciclo ON/OFF AR32/AR33. 0 = no usar este modo.',
        step: 1,
      },
    ],
  },
  {
    id: 'door',
    title: 'Puerta',
    intro: 'AR35–AR41: entrada digital de puerta, alarmas y bloqueos.',
    fields: [
      {
        key: 'F25',
        code: 'AR35',
        label: 'Habilitar entrada puerta',
        help: '1 = usa el GPIO de puerta para lógica y alarmas. 0 = ignora la entrada.',
        step: 1,
      },
      {
        key: 'F26',
        code: 'AR36',
        label: 'Tipo de contacto puerta',
        help: '0 = contacto NA (normalmente abierto). 1 = NC (normalmente cerrado). Debe coincidir con el cableado.',
        step: 1,
      },
      {
        key: 'F27',
        code: 'AR37',
        label: 'Retardo alarma puerta abierta (s)',
        help: 'Segundos con puerta abierta antes de hacer latch de alarma de puerta.',
        step: 1,
      },
      {
        key: 'F28',
        code: 'AR38',
        label: 'Apagar ventilador con puerta',
        help: '1 = corta el ventilador mientras la puerta está abierta (ahorro y confort).',
        step: 1,
      },
      {
        key: 'F29',
        code: 'AR39',
        label: 'Bloquear alarma térmica con puerta',
        help: '1 = no dispara alarmas térmicas mientras la puerta está abierta (evita falsas alarmas por aire caliente).',
        step: 1,
      },
      {
        key: 'F30',
        code: 'AR40',
        label: 'Registrar puerta por Serial',
        help: '1 = imprime en el monitor serie cada cambio abierto/cerrado para depuración.',
        step: 1,
      },
      {
        key: 'F40',
        code: 'AR41',
        label: 'Apagar compresor con puerta',
        help: '1 = apaga el compresor mientras la puerta está abierta.',
        step: 1,
      },
    ],
  },
  {
    id: 'manual',
    title: 'Manual / técnico (firmware)',
    intro: 'AR42–AR48: comandos por puerto serie en modo técnico; revisá el sketch antes de habilitar en producción.',
    fields: [
      {
        key: 'F31',
        code: 'AR42',
        label: 'Permitir compresor manual por Serial',
        help: '1 = en modo técnico permite encender el compresor por comando manual del firmware.',
        step: 1,
      },
      {
        key: 'F32',
        code: 'AR43',
        label: 'Tiempo máximo compresor manual (min)',
        help: 'Límite de seguridad para no dejar el compresor forzado indefinidamente desde serie.',
        step: 1,
      },
      {
        key: 'F33',
        code: 'AR44',
        label: 'Permitir ventilador manual por Serial',
        help: '1 = permite forzar el ventilador desde comandos serie en modo técnico.',
        step: 1,
      },
      {
        key: 'F34',
        code: 'AR45',
        label: 'Tiempo máximo ventilador manual (min)',
        help: 'Tope de tiempo para el ventilador en manual por serie.',
        step: 1,
      },
      {
        key: 'F35',
        code: 'AR46',
        label: 'Permitir deshielo manual por Serial',
        help: '1 = permite iniciar deshielo desde comandos serie en modo técnico.',
        step: 1,
      },
      {
        key: 'F36',
        code: 'AR47',
        label: 'Tiempo entre deshielos manuales (min)',
        help: 'Evita disparar deshielos manuales uno tras otro; espacio mínimo entre pedidos.',
        step: 1,
      },
      {
        key: 'F37',
        code: 'AR48',
        label: 'Deshielo inmediato al pedir',
        help: '1 = permite forzar deshielo en el acto si la lógica del firmware lo admite en modo técnico.',
        step: 1,
      },
    ],
  },
];
