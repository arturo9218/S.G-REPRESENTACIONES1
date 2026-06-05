import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { Pro400FormModel, mergePro400Params, pro400ToJsonBlob } from './pro400-params.defaults';
import { PRO400_SECTIONS } from './pro400-sections';
import { DeviceStoreService } from '../core/device-store.service';

@Component({
  selector: 'app-pro400-settings',
  templateUrl: './pro400-settings.component.html',
  styleUrls: ['./pro400-settings.component.scss'],
})
export class Pro400SettingsComponent implements OnChanges {
  @Input() deviceId: string | null = null;
  @Input() canEdit = true;

  readonly sections = PRO400_SECTIONS;
  model: Pro400FormModel | null = null;
  loading = false;
  saving = false;
  feedback = '';

  drafts: Record<string, string> = {};

  constructor(public deviceStore: DeviceStoreService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['deviceId']) void this.reload();
  }

  async reload(): Promise<void> {
    const id = this.deviceId;
    if (!id) {
      this.model = null;
      this.drafts = {};
      return;
    }
    this.loading = true;
    this.feedback = '';
    const r = await this.deviceStore.fetchPro400Params(id);
    this.model = r.params;
    this.syncDrafts();
    this.loading = false;
    if (r.error) {
      this.feedback = `No se pudo cargar: ${r.error}. Se muestran valores por defecto.`;
    }
  }

  private syncDrafts(): void {
    this.drafts = {};
    if (!this.model) return;
    for (const k of Object.keys(this.model) as (keyof Pro400FormModel)[]) {
      this.drafts[k as string] = String(this.model[k]);
    }
  }

  onDraftChange(key: keyof Pro400FormModel, v: string): void {
    if (!this.model) return;
    const cleaned = String(v).replace(',', '.').trim();
    this.drafts[key as string] = cleaned;
    if (cleaned === '-' || cleaned === '+') return;
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) this.model[key] = n;
  }

  onFieldBlur(key: keyof Pro400FormModel): void {
    if (!this.model) return;
    const draft = this.drafts[key as string] ?? '';
    const n = parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(n)) {
      this.drafts[key as string] = String(this.model[key]);
    } else {
      this.drafts[key as string] = String(n);
      this.model[key] = n;
    }
  }

  resetDefaults(): void {
    this.model = mergePro400Params(null);
    this.syncDrafts();
    this.feedback = 'Valores por defecto del manual (sin guardar aún).';
  }

  async save(): Promise<void> {
    const id = this.deviceId;
    if (!id || !this.model || !this.canEdit) return;
    this.saving = true;
    this.feedback = '';
    const r = await this.deviceStore.savePro400Params(id, pro400ToJsonBlob(this.model));
    this.saving = false;
    this.feedback = r.ok
      ? 'Guardado en la nube. El equipo lo aplicará en el próximo pull (≈1–2 min).'
      : `No se pudo guardar: ${r.error ?? 'error'}`;
  }
}
