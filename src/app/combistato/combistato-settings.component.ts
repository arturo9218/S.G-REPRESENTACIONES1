import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CombistatoFormModel, mergeCombistatoParams } from './combistato-params.defaults';
import { COMBISTATO_SECTIONS } from './combistato-sections';
import { CombistatoStoreService } from '../core/combistato-store.service';

@Component({
  selector: 'app-combistato-settings',
  templateUrl: './combistato-settings.component.html',
  styleUrls: ['./combistato-settings.component.scss'],
})
export class CombistatoSettingsComponent implements OnChanges {
  /** Registro en tabla `combistatos` (SQL 033); no se asocia al panel de temperatura. */
  @Input() combistatoId: string | null = null;
  @Input() canEdit = true;

  readonly sections = COMBISTATO_SECTIONS;

  model: CombistatoFormModel | null = null;
  loading = false;
  saving = false;
  feedback = '';
  jsonExport = '';

  constructor(public combistatoStore: CombistatoStoreService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['combistatoId']) {
      void this.reload();
    }
  }

  async reload(): Promise<void> {
    const id = this.combistatoId;
    if (!id) {
      this.model = null;
      return;
    }
    this.loading = true;
    this.feedback = '';
    this.jsonExport = '';
    const r = await this.combistatoStore.fetchCombistatoParams(id);
    this.model = r.params;
    this.loading = false;
    if (r.error) {
      this.feedback = `No se pudo cargar: ${r.error}. Se muestran valores por defecto.`;
    }
  }

  onFieldChange(key: keyof CombistatoFormModel, v: string | number): void {
    if (!this.model) return;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    if (Number.isFinite(n)) {
      this.model[key] = n;
    }
  }

  resetDefaults(): void {
    this.model = mergeCombistatoParams(null);
    this.feedback = 'Valores restaurados a los del firmware (sin guardar en la nube).';
  }

  async save(): Promise<void> {
    const id = this.combistatoId;
    if (!id || !this.model) return;
    this.saving = true;
    this.feedback = '';
    const { error } = await this.combistatoStore.upsertCombistatoParams(id, this.model);
    this.saving = false;
    this.feedback = error ? `No se pudo guardar: ${error}` : 'Guardado en la nube.';
  }

  async copyJson(): Promise<void> {
    if (!this.model) return;
    const txt = JSON.stringify(this.model, null, 2);
    this.jsonExport = '';
    try {
      await navigator.clipboard.writeText(txt);
      this.feedback =
        'JSON copiado al portapapeles. Pegalo en `/combistato.json` del ESP32 (LittleFS) o guardalo como archivo.';
    } catch {
      this.jsonExport = txt;
      this.feedback =
        'No se pudo usar el portapapeles. El JSON aparece abajo para copiar manualmente.';
    }
  }
}
