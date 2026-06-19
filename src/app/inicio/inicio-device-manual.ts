import { PR500_SECTIONS } from '../pr500/pr500-sections';
import { COMBISTATO_SECTIONS } from '../combistato/combistato-sections';
import { PRO400_SECTIONS } from '../pro400/pro400-sections';
import { DATALOGGER_SECTIONS } from '../datalogger/datalogger-sections';

export interface InicioManualItem {
  term: string;
  detail: string;
  example?: string;
}

export interface InicioManualBlock {
  title: string;
  intro?: string;
  items: InicioManualItem[];
}

export interface InicioDeviceManual {
  id: 'pr500' | 'pro400' | 'pro300' | 'datalogger';
  title: string;
  subtitle: string;
  intro: string;
  blocks: InicioManualBlock[];
}

/** Lógica en planta (sin códigos F del firmware). */
const PR500_LOGIC: Record<string, string> = {
  AR01:
    'Con el automático en cero, los relés no arrancan por presión (solo sirven pruebas manuales si las tenés habilitadas). En uno, el equipo compara la presión real con los umbrales y enciende o apaga compresores respetando los tiempos mínimos.',
  AR02:
    'Es la presión “objetivo” del sistema. Cuando la instalación se estabiliza cerca de ese valor, el control deja de pedir más potencia o empieza a soltar etapas, según el modo de reacción (AR22).',
  AR03:
    'Define qué tan lejos puede estar la presión del valor central antes de tomar una decisión. Una banda chica hace que entre y salga compresores más seguido; una banda grande suaviza el comportamiento.',
  AR04:
    'Si tenés más de un compresor, este valor separa en presión el momento en que entra el segundo respecto del primero, y el tercero respecto del segundo. Evita que todos arranquen por el mismo motivo.',
  AR05:
    'Cuando una etapa pide arrancar, el equipo espera estos segundos antes de energizar el siguiente. Reduce picos de corriente en la línea.',
  AR06:
    'Un compresor que se apagó debe permanecer apagado al menos este tiempo antes de poder volver a encenderse. Protege el compresor y el contactor.',
  AR07:
    'Una vez encendido, debe permanecer en marcha al menos este tiempo antes de que el control lo pueda apagar. Evita ciclos muy cortos.',
  AR08:
    'Horas entre cambios de “desfase” de mapeo etapa→relé. Solo actúa con AR28 = 0. Cero = sin rotación. Ver desglose en el manual.',
  AR28:
    'En cero, el reparto entre contactores sigue la rotación de AR08. En uno, el PR500 elige los compresores con menos horas de marcha acumuladas (solo entre los primeros según la cantidad configurada en AR09). Recomendado si solo tenés dos máquinas cableadas en C1 y C2.',
  AR09:
    'Cuántas etapas lógicas de demanda por presión puede activar el control a la vez (1, 2 o 3). No define qué contactor C1/C2/C3 se usa: eso lo combinan AR28 y AR08.',
  AR10:
    'Si ponés cero, no hay alarma por presión baja. Con un valor, la presión no debe quedar por debajo durante el tiempo de AR12; si lo hace, salta alarma, se apagan compresores y hay que reconocer con AR16.',
  AR11:
    'Igual que la baja, pero por encima de un tope. Cero desactiva. Con valor + tiempo AR13, protege contra sobrepresión o falla de válvula.',
  AR12:
    'Segundos seguidos por debajo del umbral de baja (AR10) antes de confirmar la alarma. Filtra bajadas muy breves.',
  AR13:
    'Segundos seguidos por encima del umbral de alta (AR11) antes de confirmar la alarma.',
  AR14:
    'Suma o resta al valor que lee el transmisor para que coincida con tu manómetro de referencia en el mismo punto de la instalación.',
  AR15:
    'Solo cambia cómo cargás y ves los números en el equipo y la app (bar o psi). La misma presión física se mantiene; en la nube la historia se guarda en bar.',
  AR16:
    'Después de una alarma de presión, poné uno y guardá para quitar el bloqueo cuando la causa ya está resuelta. El equipo vuelve a poner este valor en cero al aplicarlo.',
  AR17:
    'Con el automático en marcha (AR01 = 1), uno fuerza el primer compresor encendido aunque la presión no lo pida. Cero = automático normal. Útil para prueba en vacío con cuidado.',
  AR18: 'Igual que AR17, para el segundo compresor.',
  AR19: 'Igual que AR17, para el tercer compresor.',
  AR20: 'Número libre de taller (versión de puesta a punto). No cambia el comportamiento del control.',
  AR21: 'Reservado para uso futuro; hoy no modifica la lógica.',
  AR22:
    'Cero (clásico): las etapas suelen entrar cuando la presión cae (falta capacidad). Uno (demanda): entran cuando la presión sube y se apagan al volver al valor central de AR02.',
  AR23:
    'Si el cable del transmisor está cortado o fuera de rango eléctrico, el equipo puede detectarlo. Cero desactiva. Con segundos, confirma fallo y entra en modo de emergencia con ciclo AR24/AR25 (distinto a alarma por presión AR10/AR11).',
  AR24:
    'Con fallo de sensor confirmado, cuántos segundos los compresores configurados (AR09) quedan encendidos juntos en ese modo de emergencia.',
  AR25: 'Cuántos segundos permanecen apagados entre cada ciclo de ese modo de emergencia.',
  AR26:
    'Tensión mínima de la señal del sensor para considerar la lectura válida. Debajo de este valor se trata como cable suelto o corto.',
  AR27:
    'Tensión máxima válida. Por encima, señal inválida (típico cable abierto hacia alimentación). Debe quedar al menos 0,05 V de ventana entre AR26 y AR27.',
  AR29: 'Activa la lectura de sonda de succión en el PR500. Cero = solo presión y compresores.',
  AR30: 'Corrección en °C si la sonda de succión lee distinto a un termómetro patrón en el mismo punto.',
  AR31:
    'Tipo de refrigerante para evaluar recalentamiento cuando AR32 está activo (R134a, R404A, R22, R410A, R507A según la tabla del equipo).',
  AR32: 'En uno, calcula y valida el recalentamiento con presión + temperatura de succión. Cero = no evalúa.',
  AR33: 'Por debajo de este recalentamiento (°C) se considera fuera de zona (si AR32 está activo).',
  AR34: 'Por encima de este recalentamiento (°C) se considera fuera de zona.',
};

const PR500_EXAMPLES: Record<string, string> = {
  AR01: 'Mantenimiento: AR01 = 0 y compresores parados. Puesta en marcha: AR01 = 1 y revisar AR02/AR03.',
  AR02: 'Planta R404A con succión estable ~2,8 bar → AR02 = 2,8 (en la unidad elegida en AR15).',
  AR03: 'AR03 = 0,30 bar: la presión puede moverse ±0,30 bar alrededor del central antes de pedir otra etapa (modo clásico).',
  AR04: 'Dos compresores: AR04 = 0,20 bar hace que el segundo entre cuando la presión pide un escalón adicional de 0,20 bar.',
  AR05: 'AR05 = 120 s: tras arrancar C1, esperá 2 minutos antes de autorizar arranque de C2.',
  AR06: 'AR06 = 180 s: un compresor que se apagó no puede volver antes de 3 minutos.',
  AR07: 'AR07 = 300 s: mínimo 5 minutos de marcha por ciclo.',
  AR08:
    'Ver desglose AR08 en el manual: incluye tabla de mapeo, AR28 = 0 vs 1 y por qué a veces aparece C3 con dos compresores.',
  AR28:
    'Solo 2 compresores en C1 y C2: AR09 = 2, AR28 = 1 (balanceo por horas). Así no se energiza un tercer contactor vacío.',
  AR09:
    'Ver el desglose AR09 en el manual (varias filas): incluye 2 compresores en C1/C2, 3 máquinas y errores frecuentes.',
  AR10: 'Proteger vacío: AR10 = 1,5 bar (misma unidad que AR15), AR12 = 60 s.',
  AR11: 'AR11 = 4,5 bar, AR13 = 45 s para alarma por alta.',
  AR12: 'AR12 = 90 s: debe estar 90 s seguidos bajo AR10 para alarma.',
  AR13: 'AR13 = 60 s por encima de AR11.',
  AR14: 'Manómetro marca 3,10 bar y pantalla 3,00 bar → AR14 = +0,10.',
  AR15: 'Operador usa psi en planta → AR15 = 1; cargá los mismos números que el manómetro.',
  AR16: 'Tras reparar fuga y ver presión normal: AR16 = 1, guardar, verificar que vuelve a 0 y compresores pueden arrancar.',
  AR17: 'Prueba de contactor C1: AR01 = 1, AR17 = 1 (resto en 0), tiempo limitado y personal presente.',
  AR18: 'Prueba C2: AR18 = 1.',
  AR19: 'Prueba C3: AR19 = 1.',
  AR20: 'AR20 = 12 puede significar “puesta a punto marzo 2026” para el taller.',
  AR21: 'Dejar en 0.',
  AR22: 'Cámara frigorífica clásica: AR22 = 0. Proceso que pide potencia cuando sube presión: AR22 = 1.',
  AR23: 'AR23 = 30 s: 30 s de señal inválida confirman alarma de sensor. AR23 = 0: no vigilar cable.',
  AR24: 'AR24 = 120 s de marcha forzada en emergencia por sensor.',
  AR25: 'AR25 = 180 s apagado entre ciclos de emergencia.',
  AR26: 'Por defecto ~0,08 V; bajar si tu transmisor no llega a 0 V con presión mínima.',
  AR27: 'Por defecto ~3,22 V; ajustar si tu escalado usa menos de 3,3 V.',
  AR29: 'Con sonda en succión cableada: AR29 = 1.',
  AR30: 'Sonda 6,2 °C, termómetro 6,0 °C → AR30 = −0,2 °C.',
  AR31: 'Instalación R404A → elegir R404A en la lista (valor 2 en equipo).',
  AR32: 'Supervisar recalentamiento: AR32 = 1 y definir AR33/AR34.',
  AR33: 'AR33 = 4 °C: por debajo, posible líquido en succión.',
  AR34: 'AR34 = 12 °C: por encima, posible poca carga o válvula muy abierta.',
};

const SECTION_INTROS: Record<string, string> = {
  'f01-f08':
    'Presión de trabajo, tiempos entre arranques y cómo reparte los compresores. Si te cuesta AR08, empezá por las filas que dicen “en simple” y “no es turnarse”.',
  'f09-f16':
    'Parámetros AR09 a AR16. AR09 es el que más confunde: primero leé su desglose (varias filas). Luego alarmas de presión, corrección del manómetro y unidad bar/psi.',
  'f17-f22': 'Parámetros AR17 a AR22: pruebas manuales por compresor y modo clásico o “demanda” de presión.',
  'f23-f27':
    'Parámetros AR23 a AR27: detección de cable o sensor de presión dañado y ciclo de emergencia (diferente a alarma AR10/AR11).',
  'f29-f34': 'Parámetros AR29 a AR34: sonda de succión opcional y recalentamiento.',
};

/** AR08 explicado para operadores sin conocer el firmware. */
function buildAr08ManualItems(): InicioManualItem[] {
  return [
    {
      term: 'AR08 — En simple (léelo primero)',
      detail:
        'AR08 es “cada cuántas horas puede cambiar la forma en que el PR500 reparte el trabajo entre los contactores C1, C2 y C3”. Ese cambio solo ocurre cuando los tres contactores están apagados al mismo tiempo. Si ponés AR08 = 0, nunca cambia esa forma (queda fija).',
      example:
        'AR08 = 24: como mucho una vez por día, y solo si en ese momento ningún compresor está en marcha, el equipo puede pasar al siguiente esquema de reparto.',
    },
    {
      term: 'AR08 — Cuándo lo tenés que mirar',
      detail:
        'Solo importa si AR28 está en 0 (reparto por rotación). Si AR28 está en 1 (balanceo por horas trabajadas), el equipo elige solo entre los compresores que correspondan y AR08 no manda en eso. Para la mayoría de las plantas con dos motores en C1 y C2, lo más seguro es AR28 = 1 y AR08 = 0.',
    },
    {
      term: 'AR08 — Lo que casi todos entienden mal',
      detail:
        'AR08 no hace que los compresores se turnen de a uno. No significa “si prende el segundo, apaga el primero”. Si hace falta más frío y la presión lo pide, pueden quedar dos compresores encendidos juntos. Los tiempos AR05, AR06 y AR07 solo evitan arranques y paradas muy seguidos; no son un turno.',
      example:
        'En la curva ves C1 y C2 a la vez: puede ser normal cuando la instalación necesita más capacidad.',
    },
    {
      term: 'AR08 — C1, C2 y C3 en la app',
      detail:
        'C1, C2 y C3 son los tres contactores del controlador. No siempre hay tres máquinas en la sala: a veces el tercer contactor no tiene motor. Con AR28 = 0 y AR08 mayor que 0, el equipo puede encender C3 aunque solo tengas dos compresores cableados, porque está siguiendo un esquema de rotación, no porque detectó una tercera máquina.',
    },
    {
      term: 'AR08 — Tabla para dos compresores pidiendo marcha',
      detail:
        'Con AR28 = 0 y hace falta el primer y el segundo escalón de potencia: en el esquema 0 suele encender C1 y C2; en el esquema 1 suele C2 y C3; en el esquema 2 suele C3 y C1. El esquema cambia con AR08 cuando todos están parados. Si solo tenés motores en C1 y C2, no uses rotación: poné AR28 = 1, AR09 = 2 y AR08 = 0.',
      example:
        'Ves C2 y C3 encendidos pero solo hay dos motores → revisá AR28 y AR08 antes de pensar que el equipo falló.',
    },
    {
      term: 'AR08 — Qué cargar según tu planta',
      detail:
        'Un solo compresor: AR09 = 1 (AR08 da igual en la práctica). Dos compresores en C1 y C2, sin usar C3: AR09 = 2, AR28 = 1, AR08 = 0. Tres compresores y querés cambiar el “líder” cada X horas: AR09 = 3, AR28 = 0, AR08 = 24 (u otro número de horas). Tres compresores y reparto por desgaste: AR28 = 1, AR09 = 3, AR08 = 0.',
    },
  ];
}

/** AR09: etapas lógicas vs relés C1/C2/C3 — desglose aparte porque suele malinterpretarse. */
function buildAr09ManualItems(): InicioManualItem[] {
  return [
    {
      term: 'AR09 — Qué controla (etapas lógicas)',
      detail:
        'AR09 vale 1, 2 o 3. Fija cuántas etapas de demanda por presión puede pedir marcha el automático a la vez (según AR02, AR03, AR04 y AR22). La etapa 0 es la primera escalón; la 1 la segunda; la 2 la tercera. Con AR09 = 2 solo existen etapas 0 y 1: la tercera etapa lógica nunca entra, aunque tengas un tercer contactor cableado.',
      example:
        'Presión baja y el control necesita más capacidad: con AR09 = 2 pueden pedirse las etapas 0 y 1 a la vez (dos compresores en paralelo si la presión y los tiempos AR05–AR07 lo permiten).',
    },
    {
      term: 'AR09 — Qué NO es (errores frecuentes)',
      detail:
        'No es “cuántos cables hay en la pared”. No es “solo usar C1 y C2” (eso depende de AR28 y AR08). No es “un solo motor a la vez”: si dos etapas piden ON, pueden quedar dos compresores encendidos juntos. C1, C2 y C3 en la app son los tres contactores; pueden mostrarse aunque en planta solo haya dos máquinas si el mapeo apunta al tercer contactor.',
    },
    {
      term: 'AR09 = 1',
      detail:
        'Solo la etapa lógica 0 participa. Un escalón de potencia automático. Útil con un solo compresor en servicio o cuando querés limitar el automático a una máquina.',
      example: 'Un compresor en C1 → AR09 = 1. AR28 puede quedar en 0 o 1; con una sola etapa el reparto entre contactores casi no importa.',
    },
    {
      term: 'AR09 = 2',
      detail:
        'Hasta dos etapas lógicas (0 y 1) pueden estar activas según presión. No desactiva el contactor C3 por sí solo: con AR28 = 0 y AR08 > 0, una etapa puede mapearse a C3 aunque no tengas “tercera máquina”. Para dos compresores reales en C1 y C2 usá AR09 = 2 y AR28 = 1 (balanceo por horas solo entre esos dos contactores).',
      example:
        'Dos compresores en C1 y C2, C3 vacío: AR09 = 2, AR28 = 1, AR08 = 0 (o AR08 alto si no querés rotación). AR17/AR18/AR19 = 0.',
    },
    {
      term: 'AR09 = 3',
      detail:
        'Las tres etapas lógicas pueden participar. Instalación con tres compresores o tres escalones de potencia por presión. Con AR28 = 1 el balanceo reparte desgaste entre C1, C2 y C3.',
      example: 'Tres máquinas en paralelo por presión → AR09 = 3; AR28 = 1 para reparto por horómetro o AR28 = 0 + AR08 si preferís rotación de lead.',
    },
    {
      term: 'AR09 + AR28 + AR08 (cómo se leen juntos)',
      detail:
        'AR09 = cuántas etapas pueden pedir marcha. AR28 = 0: cada etapa se asigna a un contactor con rotación (AR08 cambia el “desfase” entre C1/C2/C3; no apaga C1 al prender C2). AR28 = 1: solo se usan los primeros AR09 contactores, eligiendo los de menos horas ON. Si en telemetría ves C3 con dos compresores en planta, revisá AR28, AR08 y que no tengas AR19 = 1 en prueba.',
      example:
        'AR28 = 0, AR08 = 24, AR09 = 2, ambas etapas ON: según la rotación puede verse C2 + C3 (no es fallo de AR09). Solución típica: AR28 = 1 y AR09 = 2.',
    },
  ];
}

function cleanHelpText(help: string | undefined): string {
  if (!help?.trim()) return '';
  return help
    .replace(/\bF\d+\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+·\s+/g, ' ')
    .trim();
}

function buildPr500DeviceManual(): InicioDeviceManual {
  const blocks: InicioManualBlock[] = PR500_SECTIONS.map((section) => ({
    title: section.title.replace(/^Bloque \d+ · /, ''),
    intro: SECTION_INTROS[section.id] ?? undefined,
    items: section.fields.flatMap((field) => {
      if (field.code === 'AR08') return buildAr08ManualItems();
      if (field.code === 'AR09') return buildAr09ManualItems();
      const logic = PR500_LOGIC[field.code] ?? '';
      const help = cleanHelpText(field.help);
      const detail = [logic, help].filter(Boolean).join(' ').trim();
      return [
        {
          term: `${field.code} — ${field.label}`,
          detail: detail || `Parámetro ${field.code}: ${field.label}.`,
          example: PR500_EXAMPLES[field.code],
        },
      ];
    }),
  }));

  return {
    id: 'pr500',
    title: 'PR500 — Manual completo (AR01 a AR34)',
    subtitle: 'Todos los parámetros en orden, con lógica y ejemplos',
    intro:
      'En la app y en el equipo verás códigos AR01, AR02, … AR34. Cada uno es un ajuste concreto. Abajo van en el mismo orden que en Configuración → PR500. Leé el bloque, ajustá en el controlador y guardá. La telemetría en la nube muestra presión (siempre en bar en historial), compresores ON y alarmas.',
    blocks,
  };
}

function buildPro300DeviceManual(): InicioDeviceManual {
  const blocks: InicioManualBlock[] = COMBISTATO_SECTIONS.map((section) => ({
    title: section.title,
    intro: section.intro,
    items: section.fields.map((field) => ({
      term: `${field.code} — ${field.label}`,
      detail: field.help ?? `Parámetro ${field.code}: ${field.label}.`,
    })),
  }));

  return {
    id: 'pro300',
    title: 'PRO300 — Manual completo (AR01 a AR48)',
    subtitle: 'Controlador de cámara: 2 sondas + compresor / ventilador / deshielo',
    intro:
      'Controlador de cámara con dos sondas de temperatura y tres relés (compresor, ventilador y deshielo). En la app y en el equipo verás códigos AR01, AR02, … AR48; cada uno es un ajuste concreto. Abajo van en el mismo orden que en Configuración → PRO300. Leé el bloque, ajustá y guardá. La telemetría a la nube muestra T1, T2 y el estado de cada relé.',
    blocks,
  };
}

const PRO400_EXAMPLES: Record<string, string> = {
  AR01: 'Cámara de congelados: AR01 = −20 °C con AR05 = 2 °C de histéresis.',
  AR02: 'Pantalla marca −18,2 °C y termómetro patrón −18,0 °C → AR02 = +0,2 °C.',
  AR05: 'AR05 = 1,5 °C: banda estrecha, compresor más sensible; AR05 = 4 °C: ciclos más espaciados.',
  AR07: 'AR07 = 300 s: mínimo 5 minutos de marcha por ciclo.',
  AR08: 'AR08 = 180 s: no reencender antes de 3 minutos apagado.',
  AR09: 'AR09 = 240 min: deshielo automático cada 4 h de refrigeración tras el goteo.',
  AR10: 'AR10 = 30 min: deshielo corta a los 30 min aunque no haya sonda de evaporador.',
  AR15: 'Taller: AR15 = 0 (apagar si falla sonda). Planta con producto sensible: AR15 = 1 con AR16/AR17 acordes.',
  AR21: 'Siempre AR21 = 2 para ver curva en la app; AR22 = 60–120 s según necesidad.',
  AR23: 'AR23 = 0,5 °C: envía antes si la temperatura se movió medio grado.',
  AR50: 'Compresor no arranca con relé en reposo: probá AR50 = 1 (o viceversa).',
};

function buildPro400DeviceManual(): InicioDeviceManual {
  const paramBlocks: InicioManualBlock[] = PRO400_SECTIONS.map((section) => ({
    title: section.title,
    intro: section.intro,
    items: section.fields.map((field) => ({
      term: `${field.code} — ${field.label}`,
      detail: field.help ?? `Parámetro ${field.code}: ${field.label}.`,
      example: PRO400_EXAMPLES[field.code],
    })),
  }));

  const blocks: InicioManualBlock[] = [
    {
      title: 'Operación en planta',
      intro: 'Alta del equipo, alertas y qué ver en la app.',
      items: [
        {
          term: 'Alta y credenciales',
          detail:
            'Al agregar un PRO400 en Inicio copiá el ID de módulo y el código de 6 dígitos al portal WiFi del equipo (PRO400-Setup). Sin esos datos no hay curva ni parámetros en la nube.',
          example: 'Nombre “Cámara norte”, umbrales −22 °C / −15 °C en Notificaciones para congelados.',
        },
        {
          term: 'Telemetría',
          detail:
            'La app muestra temperatura (T1), estado del compresor, fase (frío, deshielo, goteo, arranque, emergencia) y minutos restantes. Requiere AR21 = 2 y WiFi estable.',
        },
        {
          term: 'Alertas push',
          detail:
            'Configurá mínimo y máximo de temperatura en Notificaciones del equipo. Fuera de rango o sin datos unos minutos genera alerta si las notificaciones están activas.',
        },
        {
          term: 'Un solo relé',
          detail:
            'El PRO400 usa un único contactor (compresor y deshielo comparten la misma salida). No hay relé de ventilador físico: fan_on en la app es estado lógico del control.',
        },
      ],
    },
    {
      title: 'Botonera y display',
      intro: 'Mismas combinaciones que el PRO300.',
      items: [
        {
          term: 'Menú parámetros (A01…A50)',
          detail: 'UP + DOWN ~1,2 s abre el menú. SET en un código entra a editar; SET de nuevo guarda en el equipo y dispara envío a la nube.',
        },
        {
          term: 'Portal WiFi',
          detail:
            'SET solo ~4 s, o SET + ABAJO / UP / VOLVER ~0,8 s, o portal forzado al encender. Configurá red, ID de módulo y token.',
        },
        {
          term: 'Deshielo manual',
          detail: 'UP solo ~1,2 s inicia deshielo. UP toque durante deshielo o goteo lo cancela.',
        },
        {
          term: 'Vistas del display',
          detail:
            'DOWN toque alterna: temperatura → fase (dEF, GOT, bOO, etc.) → minutos restantes de fase. VOLVER vuelve a temperatura. Con sonda fallada muestra E1.',
        },
        {
          term: 'Códigos A vs AR',
          detail:
            'En el display 7-seg verás A01, A02, … (equipo). En la app y en este manual son AR01, AR02, … Es el mismo parámetro.',
          example: 'A09 en el equipo = AR09 intervalo de deshielo en la app.',
        },
      ],
    },
    ...paramBlocks,
  ];

  return {
    id: 'pro400',
    title: 'PRO400 — Manual completo (AR01 a AR26 + AR50)',
    subtitle: 'Controlador de cámara: 1 sonda + un relé compresor/deshielo',
    intro:
      'Controlador de cámara con una sonda NTC y un relé. En la app verás AR01…AR26 y AR50; en el equipo A01…A26 y A50. Abajo van en el mismo orden que Configuración → PRO400. Ajustá, guardá y verificá la curva en la nube.',
    blocks,
  };
}

const DATALOGGER_EXAMPLES: Record<string, string> = {
  AR12: 'Monitoreo cada minuto: AR12 = 60. Prueba en banco: AR12 = 15.',
  AR13: 'Sin WiFi estable: AR13 = 0 hasta tener red; luego AR13 = 1.',
  AR14: 'Línea 220 V monofásico: AR14 = 220. Trifásico 380 V entre fases: AR14 = 380.',
  AR21: 'Módulo SCT con jumper 30 A/1 V en C1 → AR21 = 30, guardar y sincronizar (comando pull).',
  AR24: 'Solo T1 cableada al inicio: AR24 = 1, AR25–AR29 = 0.',
  AR33: 'Succión con transductor 4–20 mA: AR33 = 1; verificar lectura con comando raw en consola serie.',
  AR35: 'Sonda marca −17,8 °C y termómetro −18,0 °C → AR35 = −0,2 °C.',
  AR41: 'Pinza lee 0,3 A de más con carga conocida → AR41 = −0,3 A.',
  AR47: 'Manómetro 3,10 bar y pantalla 3,00 bar → AR47 = +0,10 bar.',
};

function buildDataloggerDeviceManual(): InicioDeviceManual {
  const factoryChannelItems: InicioManualItem[] = [
    { term: 'AR01 — T1', detail: 'Canal de temperatura 1. Asignación de fábrica; no editable en la app.' },
    { term: 'AR02 — T2', detail: 'Canal de temperatura 2.' },
    { term: 'AR03 — T3', detail: 'Canal de temperatura 3.' },
    { term: 'AR04 — T4', detail: 'Canal de temperatura 4.' },
    { term: 'AR05 — T5', detail: 'Canal de temperatura 5.' },
    { term: 'AR06 — T6', detail: 'Canal de temperatura 6.' },
    { term: 'AR07 — C1', detail: 'Canal de corriente / consumo 1 (módulo SCT).' },
    { term: 'AR08 — C2', detail: 'Canal de corriente 2.' },
    { term: 'AR09 — C3', detail: 'Canal de corriente 3.' },
    { term: 'AR10 — P1', detail: 'Canal de presión 1 (transductor 4–20 mA, igual PR500).' },
    { term: 'AR11 — P2', detail: 'Canal de presión 2.' },
  ];

  const paramBlocks: InicioManualBlock[] = DATALOGGER_SECTIONS.map((section) => ({
    title: section.title,
    intro: section.intro,
    items: section.fields.map((field) => ({
      term: `${field.code} — ${field.label}`,
      detail: field.help ?? `Parámetro ${field.code}: ${field.label}.`,
      example: DATALOGGER_EXAMPLES[field.code],
    })),
  }));

  const blocks: InicioManualBlock[] = [
    {
      title: 'Alta y operación',
      intro: 'Credenciales, WiFi y consola serie del Datalogger.',
      items: [
        {
          term: 'Alta en la app',
          detail:
            'Inicio → Agregar Datalogger. Copiá moduleId y deviceToken al portal WiFi del equipo (Datalogger-Setup). Sin eso no hay telemetría ni parámetros.',
          example: 'moduleId ARTURO, token de 6 dígitos, api_url de ingest-reading.',
        },
        {
          term: 'Sincronizar parámetros',
          detail:
            'Tras guardar AR12–AR48 en la app, el Datalogger baja la config con el comando pull o en el próximo envío si cambiaron los parámetros.',
          example: 'Consola serie: escribí pull y verificá escalas SCT.',
        },
        {
          term: 'Comandos serie (115200)',
          detail:
            'En consola: help (ayuda), status (estado), raw (valores de calibración), tx (envío manual a la nube), pull (bajar parámetros desde la app) y wifi (portal de red).',
          example:
            'Sin carga en la pinza SCT, raw debe mostrar corriente cerca de 0 A. En presión, verifica lectura estable a 0,5 bar con el transductor calibrado.',
        },
        {
          term: 'Presión 4-20 mA',
          detail:
            'Mismo cableado que PR500. Positivo del transmisor a 150 ohm y a la entrada de presión del Datalogger. Negativo a masa común. Escala de 0,5 bar (4 mA) a 8 bar (20 mA).',
        },
        {
          term: 'Escala SCT',
          detail:
            'AR21, AR22 y AR23 deben coincidir con el jumper del módulo SCT (10, 20, 30, 50 o 60 A por cada 1 V de salida). Corriente en A = voltaje de salida x valor del AR del canal.',
          example: 'Jumper 30 A/1 V en C1: AR21 = 30, guardar en la app y ejecutar pull.',
        },
      ],
    },
    {
      title: 'Canales de fábrica (AR01-AR11)',
      intro:
        'Cada sensor tiene un canal fijo en el Datalogger. No se cambian desde la app. AR24 a AR34 activan o desactivan cada canal.',
      items: factoryChannelItems,
    },
    ...paramBlocks,
  ];

  return {
    id: 'datalogger',
    title: 'Datalogger — Manual completo (AR12 a AR48)',
    subtitle: '6 temperaturas, 3 consumos y 2 presiones',
    intro:
      'Datalogger multi-canal: 6 temperaturas, 3 consumos y 2 presiones. En la app configurás AR12–AR48 (telemetría, sensores activos, escalas SCT, correcciones y alarmas). Los canales AR01–AR11 son de fábrica. Abajo van en el mismo orden que Configuración → Datalogger.',
    blocks,
  };
}

export const INICIO_DEVICE_MANUALS: InicioDeviceManual[] = [
  buildPr500DeviceManual(),
  buildPro400DeviceManual(),
  buildPro300DeviceManual(),
  buildDataloggerDeviceManual(),
];
