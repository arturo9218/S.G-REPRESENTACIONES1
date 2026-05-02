import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import {
  clampPr500F02,
  clampPr500F03,
  clampPr500F26F27,
  convertPr500PressureParamsForF15,
  mergePr500Params,
  normalizePr500F01,
  pr500BarToPsi,
  PR500_F02_BAR_MAX,
  PR500_F02_BAR_MIN,
  PR500_F03_BAR_MAX,
  PR500_F03_BAR_MIN,
  PR500_PSI_PER_BAR,
  type Pr500FormModel,
} from './pr500-params.defaults';
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

  private seedBleConfigFromController(): void {
    const id = this.pr500Id;
    if (!id) return;
    const p = this.pr500Store.snapshot.find((x) => x.id === id);
    this.bleConfig.api_url = this.pr500Store.getIngestUrl();
    if (p?.moduleId) this.bleConfig.module_id = p.moduleId;
    if (p?.deviceToken) this.bleConfig.api_key = p.deviceToken;
  }

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
      this.seedBleConfigFromController();
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
    this.seedBleConfigFromController();
    this.loading = false;
    if (r.error) {
      this.feedback = `No se pudo cargar: ${r.error}. Se muestran valores por defecto.`;
    }
  }

  onFieldChange(key: keyof Pr500FormModel, v: string | number): void {
    if (!this.model) return;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) return;
    if (key === 'F01' || key === 'F22') {
      this.model[key] = normalizePr500F01(n);
      return;
    }
    if (key === 'F02') {
      this.model.F02 = clampPr500F02(n, this.model.F15);
      return;
    }
    if (key === 'F03') {
      this.model.F03 = clampPr500F03(n, this.model.F15);
      return;
    }
    if (key === 'F23') {
      let v = Math.round(n);
      if (v < 0) v = 0;
      else if (v > 0 && v < 5) v = 5;
      else if (v > 600) v = 600;
      this.model.F23 = v;
      return;
    }
    if (key === 'F24' || key === 'F25') {
      const v = Math.min(7200, Math.max(10, Math.round(n)));
      this.model[key] = v;
      return;
    }
    if (key === 'F26' || key === 'F27') {
      this.model[key] = n;
      clampPr500F26F27(this.model);
      return;
    }
    if (key === 'F15') {
      const next = n >= 0.5 ? 1 : 0;
      const prev = this.model.F15 >= 0.5 ? 1 : 0;
      if (prev !== next) {
        convertPr500PressureParamsForF15(this.model, prev, next);
        this.feedback =
          next === 1
            ? 'Unidad: psi. Se convirtieron F02, F03, F04, F10, F11 y F14 desde bar (guardá para aplicar al equipo).'
            : 'Unidad: bar. Se convirtieron F02, F03, F04, F10, F11 y F14 desde psi (guardá para aplicar al equipo).';
      }
      this.model.F15 = next;
      this.model.F02 = clampPr500F02(this.model.F02, this.model.F15);
      this.model.F03 = clampPr500F03(this.model.F03, this.model.F15);
      return;
    }
    this.model[key] = n;
  }

  /** Límites del input F02 según F15 (bar vs psi), alineados al firmware Stage3. */
  f02InputMin(m: Pr500FormModel): number {
    return m.F15 >= 0.5 ? PR500_F02_BAR_MIN * PR500_PSI_PER_BAR : PR500_F02_BAR_MIN;
  }

  f02InputMax(m: Pr500FormModel): number {
    return m.F15 >= 0.5 ? PR500_F02_BAR_MAX * PR500_PSI_PER_BAR : PR500_F02_BAR_MAX;
  }

  f03InputMin(m: Pr500FormModel): number {
    return m.F15 >= 0.5 ? PR500_F03_BAR_MIN * PR500_PSI_PER_BAR : PR500_F03_BAR_MIN;
  }

  f03InputMax(m: Pr500FormModel): number {
    return m.F15 >= 0.5 ? PR500_F03_BAR_MAX * PR500_PSI_PER_BAR : PR500_F03_BAR_MAX;
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
      this.seedBleConfigFromController();
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
      const usePsi = this.model != null && this.model.F15 >= 0.5;
      const bits = [
        p != null && Number.isFinite(p)
          ? usePsi
            ? `P=${pr500BarToPsi(p).toFixed(1)} psi (${p.toFixed(2)} bar telem.)`
            : `P=${p.toFixed(2)} bar`
          : null,
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
