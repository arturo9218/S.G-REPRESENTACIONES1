export interface DashboardDevice {
  id: string;
  name: string;
  location: string;
  /** null hasta que llegue una lectura (ESP8266 o manual) */
  temperatureC: number | null;
  /** Segundo canal DS18B20 (mismo bus OneWire); null si no hay dato */
  temperature2C?: number | null;
  online: boolean;
  updatedAtLabel: string;
  batteryPct?: number | null;
  /**
   * Mismo identificador que uses en el firmware del ESP8266.
   * Conexión típica: el ESP hace HTTP POST a tu API con { "moduleId": "...", "temperatureC": 3.2 }
   * y el backend busca el dispositivo por moduleId y llama a recordTemperatureReading.
   * Ver comentario en device-store.service.ts (ESP8266).
   */
  moduleId?: string;
  espLocalIp?: string;
  /** Si está en false, no se generan alertas de temperatura para este dispositivo */
  alertsEnabled?: boolean;
  /** Umbral de temperatura baja (<=), null = sin umbral */
  tempLowC?: number | null;
  /** Umbral de temperatura alta (>=), null = sin umbral */
  tempHighC?: number | null;
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
  /** UUID del dueño en Supabase (solo relleno en vista admin) */
  ownerUserId?: string;
  /** Creado en Supabase; lecturas vienen de la nube */
  cloudSynced?: boolean;
  /** Código de 6 dígitos para WiFiManager api_key (solo en este navegador tras el alta) */
  deviceToken?: string;
  /** Etiquetas mostradas para temp1 / temp2 (Supabase + localStorage) */
  sensor1Label?: string;
  sensor2Label?: string;
  /** Suma en °C al valor crudo del ESP (corrección de sensor); default 0 */
  temp1OffsetC?: number;
  temp2OffsetC?: number;
  temp3OffsetC?: number;
}

/** Una lectura guardada para historial y gráficos */
export interface TemperatureReading {
  deviceId: string;
  at: string;
  /** Temperatura principal usada en gráfico y alertas (bruto + offset actual del dispositivo si hay raw) */
  temperatureC: number;
  /** Bruto del ESP antes de corrección (si existe en DB / ingesta); si falta, temperatureC es el valor guardado tal cual */
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
