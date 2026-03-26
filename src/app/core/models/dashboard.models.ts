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
  /** Creado en Supabase; lecturas vienen de la nube */
  cloudSynced?: boolean;
  /** Código de 6 dígitos para WiFiManager api_key (solo en este navegador tras el alta) */
  deviceToken?: string;
  /** Etiquetas mostradas para temp1 / temp2 (Supabase + localStorage) */
  sensor1Label?: string;
  sensor2Label?: string;
}

/** Una lectura guardada para historial y gráficos */
export interface TemperatureReading {
  deviceId: string;
  at: string;
  /** Temperatura principal usada en gráfico y alertas */
  temperatureC: number;
  /** Canales opcionales extras */
  temp2C?: number | null;
  temp3C?: number | null;
  powerW?: number | null;
  press1Bar?: number | null;
  press2Bar?: number | null;
}

export interface DashboardAlert {
  id: string;
  deviceName: string;
  temperatureC: number | null;
  /** Texto corto en UI (pedido: solo "Dispositivo") */
  message: string;
  severity: 'warning' | 'critical';
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
  timeLabel: string;
  sensor1Label?: string;
  sensor2Label?: string;
}
