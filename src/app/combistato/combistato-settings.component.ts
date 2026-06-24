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

  /**
   * Buffer string por campo. Existe para permitir estados intermedios mientras se
   * tipea (p.ej. solo "-" antes de poner los dígitos del número negativo). Con
   * type=number + [ngModel] one-way Angular re-renderizaba el input y borraba el
   * "-" antes de que el usuario pudiera completar "-18". Acá guardamos lo que se
   * vea en pantalla y solo escribimos al modelo cuando parseFloat es finito.
   */
  drafts: Record<string, string> = {};

  constructor(public combistatoStore: CombistatoStoreService) {}

  get combistatoFromStore() {
    const id = this.combistatoId;
    if (!id) return null;
    return this.combistatoStore.snapshot.find((c) => c.id === id) ?? null;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['combistatoId']) {
      void this.reload();
    }
  }

  async reload(): Promise<void> {
    const id = this.combistatoId;
    if (!id) {
      this.model = null;
      this.drafts = {};
      return;
    }
    this.loading = true;
    this.feedback = '';
    this.jsonExport = '';
    const r = await this.combistatoStore.fetchCombistatoParams(id);
    this.model = r.params;
    this.syncDraftsFromModel();
    this.loading = false;
    if (r.error) {
      this.feedback = `No se pudo cargar: ${r.error}. Se muestran valores por defecto.`;
    }
  }

  /** Reescribe todos los drafts a partir del modelo (después de cargar/reset). */
  private syncDraftsFromModel(): void {
    this.drafts = {};
    if (!this.model) return;
    for (const k of Object.keys(this.model) as (keyof CombistatoFormModel)[]) {
      this.drafts[k as string] = String(this.model[k]);
    }
  }

  onDraftChange(key: keyof CombistatoFormModel, v: string): void {
    if (!this.model) return;
    // Mostramos SIEMPRE lo que tipeó el usuario; el modelo solo se actualiza si
    // hay un número finito. Eso permite tipear "-" → "-1" → "-18" sin que el
    // input se borre/revierta entre keystrokes. En móvil, inputmode=decimal no
    // trae tecla "-" — usamos inputmode=text en el template.
    const cleaned = String(v).replace(',', '.').trim();
    this.drafts[key as string] = cleaned;
    if (cleaned === '-' || cleaned === '+') return;
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) {
      this.model[key] = n;
    }
  }

  onFieldBlur(key: keyof CombistatoFormModel): void {
    if (!this.model) return;
    const draft = this.drafts[key as string] ?? '';
    const n = parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(n)) {
      // Quedó algo inválido (vacío, "-", ".", etc.): restauramos el valor real
      // del modelo así el usuario no se queda viendo un input roto.
      this.drafts[key as string] = String(this.model[key]);
    } else {
      // Normalizamos la representación visible (ej: "-18.0 " → "-18").
      this.drafts[key as string] = String(n);
      this.model[key] = n;
    }
  }

  resetDefaults(): void {
    this.model = mergeCombistatoParams(null);
    this.syncDraftsFromModel();
    this.feedback = 'Valores restaurados a los de fábrica (sin guardar en la nube).';
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
        'JSON copiado al portapapeles. Guardalo como archivo o usalo en la configuración del PRO300.';
    } catch {
      this.jsonExport = txt;
      this.feedback =
        'No se pudo usar el portapapeles. El JSON aparece abajo para copiar manualmente.';
    }
  }
}
