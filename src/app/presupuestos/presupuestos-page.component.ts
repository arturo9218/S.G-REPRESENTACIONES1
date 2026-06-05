import { Component, OnInit } from '@angular/core';
import { ToastService } from '../core/toast.service';
import {
  COMPONENT_STATUS_OPTIONS,
  SYSTEM_TYPE_OPTIONS,
  systemTypeLabel,
} from './presupuesto-circuit.catalog';
import type {
  CircuitComponentState,
  CircuitSectionState,
  ComponentStatus,
  PresupuestoProfessionalInfo,
  RefrigerationCircuitSurvey,
  RefrigerationSystemType,
} from './presupuesto-circuit.models';
import { collectMissingPdfFields, confirmPdfDespiteMissing } from './presupuesto-pdf-check';
import {
  defaultCircuitSurvey,
  emptyProfessional,
  loadDefaultProfile,
  resizeLogoFile,
  saveDefaultProfile,
} from './presupuesto-circuit.utils';
import { downloadPresupuestoPdf } from './presupuesto-pdf';
import { PresupuestoService } from './presupuesto.service';
import type { PresupuestoLineItem, PresupuestoRow, PresupuestoStatus } from './presupuesto.models';
import {
  computeTotals,
  defaultReferenceCode,
  formatMoney,
  lineTotal,
  newLineItem,
} from './presupuesto.utils';

@Component({
  selector: 'app-presupuestos-page',
  templateUrl: './presupuestos-page.component.html',
  styleUrls: ['./presupuestos-page.component.scss'],
})
export class PresupuestosPageComponent implements OnInit {
  list: PresupuestoRow[] = [];
  loading = true;
  loadError = '';
  saving = false;
  exporting = false;

  editId: string | null = null;
  referenceCode = '';
  clientName = '';
  clientPhone = '';
  clientEmail = '';
  siteAddress = '';
  workDescription = '';
  notes = '';
  items: PresupuestoLineItem[] = [newLineItem()];
  currency = 'ARS';
  taxPercent = 21;
  discountPercent = 0;
  status: PresupuestoStatus = 'borrador';
  validUntil = '';

  systemType: RefrigerationSystemType | '' = '';
  systemTypeOther = '';
  refrigerant = '';
  nominalCapacity = '';
  professional: PresupuestoProfessionalInfo = emptyProfessional();
  circuitSurvey: RefrigerationCircuitSurvey = defaultCircuitSurvey();

  readonly systemTypes = SYSTEM_TYPE_OPTIONS;
  readonly componentStatuses = COMPONENT_STATUS_OPTIONS;
  readonly statusOptions: { value: PresupuestoStatus; label: string }[] = [
    { value: 'borrador', label: 'Borrador' },
    { value: 'enviado', label: 'Enviado' },
    { value: 'aceptado', label: 'Aceptado' },
    { value: 'rechazado', label: 'Rechazado' },
  ];

  constructor(
    private readonly presupuesto: PresupuestoService,
    private readonly toast: ToastService
  ) {}

  get totals() {
    return computeTotals(this.items, this.taxPercent, this.discountPercent);
  }

  async ngOnInit(): Promise<void> {
    await this.reloadList();
    if (!this.list.length) this.startNew();
    else this.loadRow(this.list[0]);
  }

  async reloadList(): Promise<void> {
    this.loading = true;
    this.loadError = '';
    const { rows, error } = await this.presupuesto.listMine();
    this.loading = false;
    if (error) {
      let hint = '';
      if (error.includes('presupuestos')) {
        hint = ' Ejecutá 050_presupuestos.sql y 051_presupuestos_circuito_profesional.sql en Supabase.';
      }
      this.loadError = `${error}${hint}`;
      return;
    }
    this.list = rows;
  }

  startNew(): void {
    this.editId = null;
    this.referenceCode = defaultReferenceCode();
    this.clientName = '';
    this.clientPhone = '';
    this.clientEmail = '';
    this.siteAddress = '';
    this.workDescription = '';
    this.notes = '';
    this.items = [newLineItem(), newLineItem()];
    this.currency = 'ARS';
    this.taxPercent = 21;
    this.discountPercent = 0;
    this.status = 'borrador';
    this.validUntil = '';
    this.systemType = '';
    this.systemTypeOther = '';
    this.refrigerant = '';
    this.nominalCapacity = '';
    this.circuitSurvey = defaultCircuitSurvey();
    const profile = loadDefaultProfile();
    this.professional = profile ? { ...profile } : emptyProfessional();
  }

  loadRow(row: PresupuestoRow): void {
    this.editId = row.id;
    this.referenceCode = row.referenceCode ?? defaultReferenceCode();
    this.clientName = row.clientName;
    this.clientPhone = row.clientPhone ?? '';
    this.clientEmail = row.clientEmail ?? '';
    this.siteAddress = row.siteAddress ?? '';
    this.workDescription = row.workDescription ?? '';
    this.notes = row.notes ?? '';
    this.items = row.items.length ? row.items.map((i) => ({ ...i })) : [newLineItem()];
    this.currency = row.currency;
    this.taxPercent = row.taxPercent;
    this.discountPercent = row.discountPercent;
    this.status = row.status;
    this.validUntil = row.validUntil ?? '';
    this.systemType = row.systemType;
    this.systemTypeOther = row.systemTypeOther ?? '';
    this.refrigerant = row.refrigerant ?? '';
    this.nominalCapacity = row.nominalCapacity ?? '';
    this.professional = { ...row.professional };
    this.circuitSurvey = {
      sections: row.circuitSurvey.sections.map((s) => ({
        ...s,
        components: s.components.map((c) => ({ ...c })),
      })),
      generalProblem: row.circuitSurvey.generalProblem,
      generalDiagnosis: row.circuitSurvey.generalDiagnosis,
    };
  }

  selectSystemType(id: RefrigerationSystemType): void {
    this.systemType = id;
  }

  async onLogoSelected(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2_500_000) {
      this.toast.show('La imagen es muy pesada. Usá un logo menor a 2,5 MB.', 'info');
      return;
    }
    const dataUrl = await resizeLogoFile(file);
    if (!dataUrl) {
      this.toast.show('No se pudo cargar el logo.', 'error');
      return;
    }
    this.professional = { ...this.professional, logoDataUrl: dataUrl };
  }

  clearLogo(): void {
    this.professional = { ...this.professional, logoDataUrl: null };
  }

  saveAsDefaultProfile(): void {
    saveDefaultProfile(this.professional);
    this.toast.success('Datos del técnico guardados como predeterminados.');
  }

  onPresentChange(c: CircuitComponentState, present: boolean): void {
    c.present = present;
    if (present && c.status === 'na') {
      c.status = 'revisar';
    }
  }

  onStatusChange(c: CircuitComponentState, status: ComponentStatus): void {
    c.status = status;
    if (status !== 'na') {
      c.present = true;
    }
  }

  trackSection(_index: number, sec: CircuitSectionState): string {
    return sec.key;
  }

  trackComponent(_index: number, c: CircuitComponentState): string {
    return c.key;
  }

  addLine(): void {
    this.items = [...this.items, newLineItem()];
  }

  removeLine(id: string): void {
    if (this.items.length <= 1) return;
    this.items = this.items.filter((i) => i.id !== id);
  }

  formatMoney(value: number): string {
    return formatMoney(value, this.currency);
  }

  lineTotal(item: PresupuestoLineItem): number {
    return lineTotal(item);
  }

  systemLabel(row: PresupuestoRow): string {
    return systemTypeLabel(row.systemType, row.systemTypeOther ?? undefined);
  }

  listLabel(row: PresupuestoRow): string {
    const ref = row.referenceCode ? `${row.referenceCode} · ` : '';
    const sys = row.systemType ? `${this.systemLabel(row)} · ` : '';
    return `${ref}${sys}${row.clientName || 'Sin cliente'}`;
  }

  listMeta(row: PresupuestoRow): string {
    const t = computeTotals(row.items, row.taxPercent, row.discountPercent);
    return `${formatMoney(t.total, row.currency)} · ${row.status}`;
  }

  async save(): Promise<void> {
    if (this.saving) return;
    const name = this.clientName.trim();
    if (!name) {
      this.toast.show('Indicá el nombre del cliente.', 'info');
      return;
    }
    if (!this.systemType) {
      this.toast.show('Seleccioná el tipo de instalación (cámara, chiller, etc.).', 'info');
      return;
    }
    const cleanItems = this.items
      .map((i) => ({
        ...i,
        description: i.description.trim(),
        quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
        unitPrice: Number(i.unitPrice) || 0,
      }))
      .filter((i) => i.description || i.unitPrice > 0);
    if (!cleanItems.length) {
      this.toast.show('Agregá al menos un ítem con descripción o importe.', 'info');
      return;
    }

    this.saving = true;
    const { row, error } = await this.presupuesto.upsert({
      id: this.editId ?? undefined,
      referenceCode: this.referenceCode,
      clientName: name,
      clientPhone: this.clientPhone,
      clientEmail: this.clientEmail,
      siteAddress: this.siteAddress,
      workDescription: this.workDescription,
      notes: this.notes,
      items: cleanItems,
      currency: this.currency,
      taxPercent: this.taxPercent,
      discountPercent: this.discountPercent,
      status: this.status,
      validUntil: this.validUntil.trim() || null,
      systemType: this.systemType,
      systemTypeOther: this.systemTypeOther,
      refrigerant: this.refrigerant,
      nominalCapacity: this.nominalCapacity,
      professional: this.professional,
      circuitSurvey: this.circuitSurvey,
    });
    this.saving = false;

    if (error) {
      this.toast.show(error, 'error');
      return;
    }
    this.toast.success('Presupuesto guardado.');
    await this.reloadList();
    if (row) this.loadRow(row);
  }

  async removeCurrent(): Promise<void> {
    if (!this.editId) return;
    if (!confirm('¿Eliminar este presupuesto?')) return;
    const { error } = await this.presupuesto.delete(this.editId);
    if (error) {
      this.toast.show(error, 'error');
      return;
    }
    this.toast.success('Presupuesto eliminado.');
    await this.reloadList();
    if (this.list.length) this.loadRow(this.list[0]);
    else this.startNew();
  }

  async exportPdf(): Promise<void> {
    if (this.exporting) return;
    const snapshot = this.buildSnapshotForPdf();
    const missing = collectMissingPdfFields(snapshot, this.items);
    if (!confirmPdfDespiteMissing(missing)) {
      return;
    }
    this.exporting = true;
    try {
      await downloadPresupuestoPdf(snapshot);
    } catch {
      this.toast.show('No se pudo generar el PDF.', 'error');
    }
    this.exporting = false;
  }

  private buildSnapshotForPdf(): PresupuestoRow {
    const now = new Date().toISOString();
    return {
      id: this.editId ?? 'draft',
      ownerUserId: '',
      referenceCode: this.referenceCode.trim() || null,
      clientName: this.clientName.trim() || 'Cliente',
      clientPhone: this.clientPhone.trim() || null,
      clientEmail: this.clientEmail.trim() || null,
      siteAddress: this.siteAddress.trim() || null,
      workDescription: this.workDescription.trim() || null,
      notes: this.notes.trim() || null,
      items: this.items.filter((i) => i.description.trim() || i.unitPrice > 0),
      currency: this.currency,
      taxPercent: this.taxPercent,
      discountPercent: this.discountPercent,
      status: this.status,
      validUntil: this.validUntil.trim() || null,
      systemType: this.systemType,
      systemTypeOther: this.systemTypeOther.trim() || null,
      refrigerant: this.refrigerant.trim() || null,
      nominalCapacity: this.nominalCapacity.trim() || null,
      professional: { ...this.professional },
      circuitSurvey: this.circuitSurvey,
      createdAt: now,
      updatedAt: now,
    };
  }
}
