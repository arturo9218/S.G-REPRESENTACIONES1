import { Injectable, NgZone } from '@angular/core';
import type { Pr500FormModel } from '../pr500/pr500-params.defaults';

/** Debe coincidir con el firmware PR500 Stage3 (`esp32_pr500_stage3_app.ino`) si el build incluye BLE. */
export const PR500_BLE_SERVICE_UUID = '12345678-1234-1234-1234-123456789001';
export const PR500_BLE_CHAR_RX_UUID = '12345678-1234-1234-1234-123456789002';
export const PR500_BLE_CHAR_TX_UUID = '12345678-1234-1234-1234-123456789003';

type BleResponse = {
  ok?: boolean;
  error?: string;
  params?: Record<string, number>;
  config?: {
    api_url?: string;
    module_id?: string;
    api_key?: string;
    supabase_anon_key?: string;
    interval_ms?: number;
    params_pull_ms?: number;
    wifi_ssid?: string;
    wifi_connected?: boolean;
    ip?: string;
  };
  pressure_bar?: number;
  r1_on?: boolean;
  r2_on?: boolean;
  r3_on?: boolean;
  r4_alarm?: boolean;
  di1_ok?: boolean;
  di2_ok?: boolean;
  di3_ok?: boolean;
  di4_ok?: boolean;
};

export type Pr500BleConfig = {
  api_url: string;
  module_id: string;
  api_key: string;
  supabase_anon_key: string;
  interval_ms: number;
  params_pull_ms: number;
  wifi_ssid: string;
  wifi_password: string;
};

/**
 * Web Bluetooth hacia el ESP32 PR500 (misma pantalla de parámetros que por nube).
 * Requiere HTTPS (o localhost) y navegador compatible (Chrome / Edge; iOS Safari limitado).
 */
@Injectable({ providedIn: 'root' })
export class Pr500BleService {
  private device: BluetoothDevice | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  private txChar: BluetoothRemoteGATTCharacteristic | null = null;
  private lineBuf = '';
  private pending: ((line: string) => void) | null = null;

  constructor(private readonly zone: NgZone) {}

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected(): boolean {
    return !!this.device?.gatt?.connected;
  }

  get deviceName(): string {
    return this.device?.name ?? '';
  }

  private clearRefs(): void {
    this.rxChar = null;
    this.txChar = null;
    this.lineBuf = '';
    this.pending = null;
  }

  async connect(): Promise<void> {
    if (!this.isSupported()) {
      throw new Error('Este navegador no expone Web Bluetooth.');
    }
    await this.disconnect();
    const d = await navigator.bluetooth!.requestDevice({
      filters: [{ namePrefix: 'PR500' }],
      optionalServices: [PR500_BLE_SERVICE_UUID],
    });
    d.addEventListener('gattserverdisconnected', () => {
      this.zone.run(() => this.clearRefs());
    });
    const server = await d.gatt!.connect();
    const svc = await server.getPrimaryService(PR500_BLE_SERVICE_UUID);
    const rx = await svc.getCharacteristic(PR500_BLE_CHAR_RX_UUID);
    const tx = await svc.getCharacteristic(PR500_BLE_CHAR_TX_UUID);
    await tx.startNotifications();
    tx.addEventListener('characteristicvaluechanged', (ev: Event) => {
      const target = ev.target as BluetoothRemoteGATTCharacteristic;
      const dv = target.value;
      if (!dv) return;
      const chunk = new TextDecoder().decode(dv.buffer as ArrayBuffer);
      this.zone.run(() => this.appendNotifyChunk(chunk));
    });
    this.device = d;
    this.rxChar = rx;
    this.txChar = tx;
  }

  async disconnect(): Promise<void> {
    try {
      await this.device?.gatt?.disconnect();
    } catch {
      /* */
    }
    this.device = null;
    this.clearRefs();
  }

  private appendNotifyChunk(chunk: string): void {
    this.lineBuf += chunk;
    for (;;) {
      const i = this.lineBuf.indexOf('\n');
      if (i < 0) break;
      const line = this.lineBuf.slice(0, i).trim();
      this.lineBuf = this.lineBuf.slice(i + 1);
      if (line && this.pending) {
        const cb = this.pending;
        this.pending = null;
        cb(line);
      }
    }
  }

  private async rpc(op: string, extra?: Record<string, unknown>): Promise<BleResponse> {
    if (!this.rxChar || !this.txChar) {
      throw new Error('Bluetooth no conectado.');
    }
    this.lineBuf = '';
    const payload = JSON.stringify({ op, ...extra }) + '\n';
    const enc = new TextEncoder().encode(payload);

    const line = await new Promise<string>((resolve, reject) => {
      const t = window.setTimeout(() => {
        this.pending = null;
        reject(new Error('Tiempo de espera BLE (12 s).'));
      }, 12000);
      this.pending = (l) => {
        window.clearTimeout(t);
        resolve(l);
      };
      void this.rxChar!
        .writeValueWithResponse(enc)
        .then(() => {
          /* la respuesta llega por notify */
        })
        .catch((e: unknown) => {
          window.clearTimeout(t);
          this.pending = null;
          reject(e);
        });
    });

    const j = JSON.parse(line) as BleResponse;
    if (j.error) throw new Error(j.error);
    return j;
  }

  async getParams(): Promise<Pr500FormModel> {
    const r = await this.rpc('getParams');
    const p = r.params;
    if (!p || typeof p !== 'object') {
      throw new Error('Respuesta BLE sin params.');
    }
    return p as Pr500FormModel;
  }

  async setParams(params: Pr500FormModel): Promise<void> {
    const plain = JSON.parse(JSON.stringify(params)) as Record<string, number>;
    await this.rpc('setParams', { params: plain });
  }

  async getLive(): Promise<BleResponse> {
    return this.rpc('getLive');
  }

  async getConfig(): Promise<Pr500BleConfig> {
    const r = await this.rpc('getConfig');
    const c = r.config;
    if (!c || typeof c !== 'object') {
      throw new Error('Respuesta BLE sin config.');
    }
    return {
      api_url: String(c.api_url ?? ''),
      module_id: String(c.module_id ?? ''),
      api_key: String(c.api_key ?? ''),
      supabase_anon_key: String(c.supabase_anon_key ?? ''),
      interval_ms: Number(c.interval_ms ?? 20000),
      params_pull_ms: Number(c.params_pull_ms ?? 120000),
      wifi_ssid: String(c.wifi_ssid ?? ''),
      wifi_password: '',
    };
  }

  async setConfig(cfg: Pr500BleConfig): Promise<{ wifi_connected?: boolean; ip?: string }> {
    const payload: Record<string, unknown> = {
      config: {
        api_url: cfg.api_url,
        module_id: cfg.module_id,
        api_key: cfg.api_key,
        supabase_anon_key: cfg.supabase_anon_key,
        interval_ms: cfg.interval_ms,
        params_pull_ms: cfg.params_pull_ms,
      },
    };
    if (cfg.wifi_ssid.trim().length > 0 && cfg.wifi_password.trim().length > 0) {
      payload['wifi_ssid'] = cfg.wifi_ssid;
      payload['wifi_password'] = cfg.wifi_password;
    }
    const r = await this.rpc('setConfig', payload);
    return {
      wifi_connected: r.config?.wifi_connected,
      ip: typeof r.config?.ip === 'string' ? r.config.ip : undefined,
    };
  }
}
