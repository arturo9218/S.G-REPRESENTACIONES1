/** Rol del usuario actual sobre el equipo en Supabase (compartido / invitación). */
export type DashboardDeviceAccessRole = 'owner' | 'editor' | 'viewer' | 'admin_view';

export interface DashboardDevice {
  id: string;
  name: string;
  location: string;
  /** null hasta que llegue una lectura (desde el dispositivo o manual) */
  temperatureC: number | null;
  /** Segundo canal DS18B20 (mismo bus OneWire); null si no hay dato */
  temperature2C?: number | null;
  online: boolean;
  updatedAtLabel: string;
  batteryPct?: number | null;
  /**
   * Mismo identificador que configurás en el equipo (portal o programa embebido).
   * Conexión típica: el dispositivo hace HTTP POST a la API con { "moduleId": "...", "temperatureC": 3.2 }
   * y el backend busca el dispositivo por moduleId y llama a recordTemperatureReading.
   * Ver comentario en device-store.service.ts (ingesta).
   */
  moduleId?: string;
  espLocalIp?: string;
  /** Si está en false, no se generan alertas de temperatura para este dispositivo */
  alertsEnabled?: boolean;
  /** Umbral de temperatura baja sensor 1 (<=), null = sin umbral */
  tempLowC?: number | null;
  /** Umbral de temperatura alta sensor 1 (>=), null = sin umbral */
  tempHighC?: number | null;
  /** Umbral bajo sensor 2; null = sin umbral (Supabase: temp2_min_c) */
  temp2LowC?: number | null;
  /** Umbral alto sensor 2; null = sin umbral (Supabase: temp2_max_c) */
  temp2HighC?: number | null;
  /** Corriente máxima RMS (A); superarla dispara alarma; null = sin umbral */
  currentMaxA?: number | null;
  /** Tensión nominal de línea (V) para P = V·I y consumo kWh; p. ej. 220 o 380 */
  nominalVoltageV?: number | null;
  /** Última corriente RMS (A) reflejada desde lecturas */
  currentA?: number | null;
  /** Última potencia (W) desde lecturas */
  powerW?: number | null;
  /** Retardo entre alertas push de temperatura para este equipo (ms) */
  tempPushCooldownMs?: number | null;
  /** Retardo entre avisos de “desconectado” (ms); independiente del de temperatura */
  offlinePushCooldownMs?: number | null;
  /** UUID del dueño en Supabase (relleno en nube cuando la columna está disponible) */
  ownerUserId?: string;
  /** Permisos de escritura en nube: viewer = solo lectura; editor/dueño pueden cambiar umbrales y ficha */
  accessRole?: DashboardDeviceAccessRole;
  /** Creado en Supabase; lecturas vienen de la nube */
  cloudSynced?: boolean;
  /** Código de 6 dígitos para el portal del dispositivo (api_key); solo en este navegador tras el alta */
  deviceToken?: string;
  /** Etiquetas mostradas para temp1 / temp2 (Supabase + localStorage) */
  sensor1Label?: string;
  sensor2Label?: string;
  /** Suma en °C al valor crudo del dispositivo (corrección de sensor); default 0 */
  temp1OffsetC?: number;
  temp2OffsetC?: number;
  temp3OffsetC?: number;
  /** Suma en A al valor de corriente del dispositivo (ingesta); default 0 */
  currentOffsetA?: number;
  /** Suma en W al valor de potencia del dispositivo (ingesta); default 0 */
  powerOffsetW?: number;
}

/** Configuración de combistato en nube (tabla `combistatos`); independiente de los paneles de lectura. */
export interface DashboardCombistato {
  id: string;
  name: string;
  location: string;
  /** Igual que en dispositivos: identificador para portal/configuración del equipo. */
  moduleId?: string;
  updatedAtLabel: string;
  /** Último POST de telemetría aceptado (columna `last_seen_at`); vacío si aún no hubo envíos. */
  lastSeenLabel: string;
  /** Conexión reciente según `last_seen_at` y el mismo umbral que paneles (`deviceOfflineAfterMs`). */
  online: boolean;
  /** Dueño en Supabase (útil en vista admin). */
  ownerUserId?: string;
  /** Código de 6 dígitos (`api_key`) disponible solo en este navegador. */
  deviceToken?: string;
}

/** PR500 — central frigorífica por presión de proceso (`pr500_controllers`); misma idea de conexión que combistatos. */
export interface DashboardPr500 {
  id: string;
  name: string;
  location: string;
  moduleId?: string;
  updatedAtLabel: string;
  lastSeenLabel: string;
  online: boolean;
  ownerUserId?: string;
  deviceToken?: string;
  /** Si true, la UI muestra la presión en psi (según `params.F15` del controlador). */
  pressureDisplayPsi?: boolean;
  /** Última fila de `pr500_readings` (bar); null si aún no hay telemetría. */
  lastPressureBar?: number | null;
  /** Estados de la misma última lectura (solo definidos si hubo lectura). */
  lastComp1On?: boolean;
  lastComp2On?: boolean;
  lastComp3On?: boolean;
  lastAlarmOn?: boolean;
  /** Ms ON acumulados (última ingesta); opcional si la columna existe en Supabase. */
  lastComp1RunMs?: number | null;
  lastComp2RunMs?: number | null;
  lastComp3RunMs?: number | null;
}

/** Marca vertical en el análisis de gráfico (Supabase: device_chart_markers). */
export interface DeviceChartMarker {
  id: string;
  deviceId: string;
  markedAt: string;
  label: string;
  note?: string | null;
  createdBy?: string;
  createdAt?: string;
}

/** Una lectura guardada para historial y gráficos */
export interface TemperatureReading {
  deviceId: string;
  at: string;
  /** Temperatura principal usada en gráfico y alertas (bruto + offset actual del dispositivo si hay raw) */
  temperatureC: number;
  /** Bruto del sensor antes de corrección (si existe en DB / ingesta); si falta, temperatureC es el valor guardado tal cual */
  temp1RawC?: number | null;
  temp2RawC?: number | null;
  temp3RawC?: number | null;
  /** Canales opcionales extras */
  temp2C?: number | null;
  temp3C?: number | null;
  /** Corriente RMS (A), ej. SCT-013 */
  currentA?: number | null;
  powerW?: number | null;
  press1Bar?: number | null;
  press2Bar?: number | null;
  /** Bruto de ingesta antes de current_offset_a (nube); si falta, currentA es el valor guardado */
  currentARaw?: number | null;
  /** Bruto de ingesta antes de power_offset_w */
  powerWRaw?: number | null;
}

/** Tipo de alarma en panel y sonido */
export type DashboardAlertKind = 'offline' | 'temp_high' | 'temp_low' | 'current_high';

/** Preset de pitido (localStorage `ar_alarm_sound_v1`) */
export type AlarmSoundPreset = 'classic' | 'buzzer' | 'chime' | 'low';

/** Estilo visual del gráfico de temperaturas (localStorage `ar_chart_style_v1`). */
export type ChartStylePreset = 'area' | 'line' | 'minimal' | 'technical' | 'trend';

export interface DashboardAlert {
  id: string;
  deviceName: string;
  temperatureC: number | null;
  /** Corriente (A) cuando kind === current_high */
  currentA?: number | null;
  /** Título corto del problema */
  message: string;
  /** Línea secundaria: umbral, °C, fecha/hora */
  detail?: string;
  kind: DashboardAlertKind;
  severity: 'warning' | 'critical';
}

/** Fila de public.device_alarm_events (historial almacenado al disparar alarma). */
export interface DeviceAlarmEvent {
  id: string;
  deviceId: string;
  triggeredAt: string;
  kind: 'temp_breach' | 'offline' | 'current_breach';
  message: string;
  detail: string | null;
  temp1C: number | null;
  temp2C?: number | null;
  /** Corriente al disparar (eventos current_breach); legacy power_breach puede traer power_w */
  currentA?: number | null;
  powerW?: number | null;
}

export interface ActivityItem {
  id: string;
  deviceName: string;
  deviceId: string;
  online: boolean;
  timeLabel: string;
  accent: 'blue' | 'teal' | 'violet';
}

export interface HistoryListItem {
  id: string;
  deviceName: string;
  temperatureC: number;
  temp2C?: number | null;
  currentA?: number | null;
  powerW?: number | null;
  timeLabel: string;
  sensor1Label?: string;
  sensor2Label?: string;
}
