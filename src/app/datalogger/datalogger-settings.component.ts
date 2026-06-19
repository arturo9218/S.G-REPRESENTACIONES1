import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import {
  DataloggerFormModel,
  mergeDataloggerParams,
  normalizeDataloggerF13,
  normalizeDataloggerOnOff,
  normalizeSctAmpsPerVolt,
  SCT_SCALE_AMPS_PER_VOLT,
  isDataloggerEnableKey,
} from './datalogger-params.defaults';
import { DATALOGGER_SECTIONS } from './datalogger-sections';
import { DataloggerStoreService } from '../core/datalogger-store.service';

@Component({
  selector: 'app-datalogger-settings',
  templateUrl: './datalogger-settings.component.html',
  styleUrls: ['./datalogger-settings.component.scss'],
})
export class DataloggerSettingsComponent implements OnChanges {
  @Input() dataloggerId: string | null = null;
  @Input() canEdit = true;

  readonly sections = DATALOGGER_SECTIONS;
  readonly sctScaleOptions = [...SCT_SCALE_AMPS_PER_VOLT];
  readonly onOffOptions: { value: 0 | 1; label: string }[] = [
    { value: 0, label: 'Apagado (0)' },
    { value: 1, label: 'Encendido (1)' },
  ];
  model: DataloggerFormModel | null = null;
  loading = false;
  saving = false;
  feedback = '';
  drafts: Record<string, string> = {};

  constructor(public dataloggerStore: DataloggerStoreService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataloggerId']) void this.reload();
  }

  async reload(): Promise<void> {
    const id = this.dataloggerId;
    if (!id) {
      this.model = null;
      this.drafts = {};
      return;
    }
    this.loading = true;
    this.feedback = '';
    const r = await this.dataloggerStore.fetchDataloggerParams(id);
    this.model = r.params;
    this.syncDrafts();
    this.loading = false;
    if (r.error) {
      this.feedback = `No se pudo cargar: ${r.error}. Valores por defecto.`;
    }
  }

  private syncDrafts(): void {
    this.drafts = {};
    if (!this.model) return;
    for (const k of Object.keys(this.model) as (keyof DataloggerFormModel)[]) {
      this.drafts[k as string] = String(this.model[k]);
    }
  }

  onDraftChange(key: keyof DataloggerFormModel, v: string): void {
    if (!this.model) return;
    const cleaned = String(v).replace(',', '.').trim();
    this.drafts[key as string] = cleaned;
    if (cleaned === '-' || cleaned === '+') return;
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n)) return;
    if (key === 'F13') {
      this.model.F13 = normalizeDataloggerF13(n);
      return;
    }
    if (isDataloggerEnableKey(key)) {
      this.model[key] = normalizeDataloggerOnOff(n);
      return;
    }
    if (key === 'F21' || key === 'F22' || key === 'F23') {
      this.model[key] = normalizeSctAmpsPerVolt(n);
      return;
    }
    (this.model as Record<keyof DataloggerFormModel, number>)[key] = n;
  }

  onSctScaleChange(key: keyof DataloggerFormModel, v: number): void {
    if (!this.model) return;
    if (key !== 'F21' && key !== 'F22' && key !== 'F23') return;
    const n = normalizeSctAmpsPerVolt(v);
    this.model[key] = n;
    this.drafts[key] = String(n);
  }

  onOnOffChange(key: keyof DataloggerFormModel, v: number): void {
    if (!this.model) return;
    if (key === 'F13') {
      this.model.F13 = normalizeDataloggerF13(v);
      this.drafts['F13'] = String(this.model.F13);
      return;
    }
    if (isDataloggerEnableKey(key)) {
      this.model[key] = normalizeDataloggerOnOff(v);
      this.drafts[key] = String(this.model[key]);
    }
  }

  onFieldBlur(key: keyof DataloggerFormModel): void {
    if (!this.model) return;
    const draft = this.drafts[key as string] ?? '';
    const n = parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(n)) {
      this.drafts[key as string] = String(this.model[key]);
    } else {
      this.onDraftChange(key, String(n));
      this.drafts[key as string] = String(this.model[key]);
    }
  }

  resetDefaults(): void {
    this.model = mergeDataloggerParams(null);
    this.syncDrafts();
    this.feedback = 'Valores por defecto (sin guardar aún).';
  }

  async save(): Promise<void> {
    const id = this.dataloggerId;
    if (!id || !this.model || !this.canEdit) return;
    this.saving = true;
    this.feedback = '';
    const params = mergeDataloggerParams(this.model);
    this.model = params;
    this.syncDrafts();
    const r = await this.dataloggerStore.upsertDataloggerParams(id, params);
    this.saving = false;
    this.feedback = r.error
      ? `No se pudo guardar: ${r.error}`
      : 'Guardado en la nube. El equipo lo aplicará en el próximo pull.';
  }
}
