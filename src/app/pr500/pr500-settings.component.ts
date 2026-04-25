import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { mergePr500Params, type Pr500FormModel } from './pr500-params.defaults';
import { PR500_SECTIONS } from './pr500-sections';
import { Pr500StoreService } from '../core/pr500-store.service';
import { Pr500BleService, type Pr500BleConfig } from '../core/pr500-ble.service';
import { environment } from '../../environments/environment';
import { isSupabaseConfigured } from '../core/supabase-config';

@Component({
  selector: 'app-pr500-settings',
  templateUrl: './pr500-settings.component.html',
  styleUrls: ['./pr500-settings.component.scss'],
})
export class Pr500SettingsComponent implements OnChanges {
  @Input() pr500Id: string | null = null;
  @Input() canEdit = true;

  readonly sections = PR500_SECTIONS;

  model: Pr500FormModel | null = null;
  loading = false;
  saving = false;
  bleBusy = false;
  feedback = '';
  jsonExport = '';
  bleConfig: Pr500BleConfig = {
    api_url: '',
    module_id: '',
    api_key: '',
    supabase_anon_key: '',
    interval_ms: 20000,
    params_pull_ms: 120000,
    wifi_ssid: '',
    wifi_password: '',
  };

  constructor(
    public pr500Store: Pr500StoreService,
    readonly pr500Ble: Pr500BleService
  ) {}

  get bleSupported(): boolean {
    return this.pr500Ble.isSupported();
  }

  get cloudSaveEnabled(): boolean {
    return environment.deviceCloudSync === true && isSupabaseConfigured();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['pr500Id']) {
      void this.reload();
    }
  }

  async reload(): Promise<void> {
    const id = this.pr500Id;
    if (!id) {
      this.model = null;
      return;
    }
    this.loading = true;
    this.feedback = '';
    this.jsonExport = '';
    const r = await this.pr500Store.fetchPr500Params(id);
    this.model = r.params;
    this.loading = false;
    if (r.error) {
      this.feedback = `No se pudo cargar: ${r.error}. Se muestran valores por defecto.`;
    }
  }

  onFieldChange(key: keyof Pr500FormModel, v: string | number): void {
    if (!this.model) return;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    if (Number.isFinite(n)) {
      this.model[key] = n;
    }
  }

  resetDefaults(): void {
    this.model = mergePr500Params(null);
    this.feedback = 'Valores restaurados a los por defecto (sin guardar en la nube).';
  }

  async connectBle(): Promise<void> {
    this.bleBusy = true;
    this.feedback = '';
    try {
      await this.pr500Ble.connect();
      this.feedback = `Bluetooth: conectado a «${this.pr500Ble.deviceName}». Podés leer/guardar parámetros y también provisionar WiFi+token del equipo.`;
    } catch (e) {
      this.feedback =
        e instanceof Error ? `Bluetooth: ${e.message}` : 'Bluetooth: no se pudo conectar.';
    } finally {
      this.bleBusy = false;
    }
  }

  async disconnectBle(): Promise<void> {
    this.bleBusy = true;
    try {
      await this.pr500Ble.disconnect();
      this.feedback = 'Bluetooth desconectado.';
    } finally {
      this.bleBusy = false;
    }
  }

  async pullFromBle(): Promise<void> {
    this.bleBusy = true;
    this.feedback = '';
    try {
      const raw = await this.pr500Ble.getParams();
      this.model = mergePr500Params(raw);
      this.feedback = 'Parámetros cargados desde el equipo (Bluetooth).';
    } catch (e) {
      this.feedback =
        e instanceof Error ? `Bluetooth: ${e.message}` : 'Bluetooth: error al leer parámetros.';
    } finally {
      this.bleBusy = false;
    }
  }

  async pullLiveBle(): Promise<void> {
    this.bleBusy = true;
    this.feedback = '';
    try {
      const r = await this.pr500Ble.getLive();
      const p = r.pressure_bar;
      const bits = [
        p != null && Number.isFinite(p) ? `P=${p.toFixed(2)} bar` : null,
        `C1 ${r.r1_on ? 'ON' : 'OFF'}`,
        `C2 ${r.r2_on ? 'ON' : 'OFF'}`,
        `C3 ${r.r3_on ? 'ON' : 'OFF'}`,
        `Al ${r.r4_alarm ? 'SÍ' : 'no'}`,
      ]
        .filter(Boolean)
        .join(' · ');
      this.feedback = `En vivo (BLE): ${bits}`;
    } catch (e) {
      this.feedback =
        e instanceof Error ? `Bluetooth: ${e.message}` : 'Bluetooth: error en lectura en vivo.';
    } finally {
      this.bleBusy = false;
    }
  }

  onBleConfigChange<K extends keyof Pr500BleConfig>(key: K, value: string | number): void {
    if (key === 'interval_ms' || key === 'params_pull_ms') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) this.bleConfig[key] = Math.max(0, Math.round(n)) as Pr500BleConfig[K];
      return;
    }
    this.bleConfig[key] = String(value) as Pr500BleConfig[K];
  }

  async pullConfigFromBle(): Promise<void> {
    this.bleBusy = true;
    this.feedback = '';
    try {
      const c = await this.pr500Ble.getConfig();
      this.bleConfig = { ...c, wifi_password: '' };
      this.feedback =
        'Configuración del equipo leída por BLE. Podés editar WiFi/token/API y aplicar al dispositivo.';
    } catch (e) {
      this.feedback =
        e instanceof Error ? `Bluetooth: ${e.message}` : 'Bluetooth: error al leer configuración.';
    } finally {
      this.bleBusy = false;
    }
  }

  async saveConfigToBle(): Promise<void> {
    this.bleBusy = true;
    this.feedback = '';
    try {
      const r = await this.pr500Ble.setConfig(this.bleConfig);
      const wifiText =
        r.wifi_connected != null
          ? r.wifi_connected
            ? `WiFi conectado (${r.ip ?? 'IP sin dato'})`
            : 'WiFi no conectado (revisá SSID/clave)'
          : 'WiFi sin cambios';
      this.feedback = `Configuración enviada al equipo por BLE. ${wifiText}.`;
    } catch (e) {
      this.feedback =
        e instanceof Error ? `Bluetooth: ${e.message}` : 'Bluetooth: error al guardar configuración.';
    } finally {
      this.bleBusy = false;
    }
  }

  async save(): Promise<void> {
    const id = this.pr500Id;
    if (!id || !this.model) return;
    this.saving = true;
    this.feedback = '';
    const parts: string[] = [];
    if (this.pr500Ble.connected) {
      try {
        await this.pr500Ble.setParams(this.model);
        parts.push('Equipo (Bluetooth)');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        parts.push(`Bluetooth falló: ${msg}`);
      }
    }
    if (this.cloudSaveEnabled) {
      const { error } = await this.pr500Store.upsertPr500Params(id, this.model);
      if (error) parts.push(`Nube: ${error}`);
      else parts.push('Nube');
    } else if (!this.pr500Ble.connected) {
      parts.push('Sin nube ni Bluetooth: no hay destino para guardar.');
    }
    this.saving = false;
    this.feedback = parts.join(' · ');
  }

  async copyJson(): Promise<void> {
    if (!this.model) return;
    const txt = JSON.stringify(this.model, null, 2);
    this.jsonExport = '';
    try {
      await navigator.clipboard.writeText(txt);
      this.feedback =
        'JSON copiado al portapapeles. Pegalo en `pr500.json` del ESP32 (LittleFS) o guardalo como archivo.';
    } catch {
      this.jsonExport = txt;
      this.feedback =
        'No se pudo usar el portapapeles. El JSON aparece abajo para copiar manualmente.';
    }
  }
}
