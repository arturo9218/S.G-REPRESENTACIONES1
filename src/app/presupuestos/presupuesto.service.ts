import { Injectable } from '@angular/core';
import { AuthService } from '../core/auth.service';
import { emptyProfessional, parseCircuitSurvey, parseSystemType } from './presupuesto-circuit.utils';
import { parseItems } from './presupuesto.utils';
import type {
  PresupuestoLineItem,
  PresupuestoProfessionalInfo,
  PresupuestoRow,
  PresupuestoStatus,
  RefrigerationCircuitSurvey,
  RefrigerationSystemType,
} from './presupuesto.models';

export interface PresupuestoPayload {
  id?: string;
  referenceCode: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  siteAddress: string;
  workDescription: string;
  notes: string;
  items: PresupuestoLineItem[];
  currency: string;
  taxPercent: number;
  discountPercent: number;
  status: PresupuestoStatus;
  validUntil: string | null;
  systemType: RefrigerationSystemType | '';
  systemTypeOther: string;
  refrigerant: string;
  nominalCapacity: string;
  professional: PresupuestoProfessionalInfo;
  circuitSurvey: RefrigerationCircuitSurvey;
}

@Injectable({ providedIn: 'root' })
export class PresupuestoService {
  constructor(private readonly auth: AuthService) {}

  async listMine(): Promise<{ rows: PresupuestoRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('presupuestos')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) {
      return { rows: [], error: error.message };
    }
    return { rows: (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>)), error: null };
  }

  async upsert(payload: PresupuestoPayload): Promise<{ row: PresupuestoRow | null; error: string | null }> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return { row: null, error: 'Iniciá sesión.' };

    const row = {
      owner_user_id: uid,
      reference_code: payload.referenceCode.trim() || null,
      client_name: payload.clientName.trim() || 'Cliente',
      client_phone: payload.clientPhone.trim() || null,
      client_email: payload.clientEmail.trim() || null,
      site_address: payload.siteAddress.trim() || null,
      work_description: payload.workDescription.trim() || null,
      notes: payload.notes.trim() || null,
      items: payload.items,
      currency: payload.currency.trim() || 'ARS',
      tax_percent: payload.taxPercent,
      discount_percent: payload.discountPercent,
      status: payload.status,
      valid_until: payload.validUntil || null,
      system_type: payload.systemType || null,
      system_type_other: payload.systemTypeOther.trim() || null,
      refrigerant: payload.refrigerant.trim() || null,
      nominal_capacity: payload.nominalCapacity.trim() || null,
      company_name: payload.professional.companyName.trim() || null,
      technician_name: payload.professional.technicianName.trim() || null,
      technician_phone: payload.professional.technicianPhone.trim() || null,
      technician_email: payload.professional.technicianEmail.trim() || null,
      technician_license: payload.professional.technicianLicense.trim() || null,
      logo_data_url: payload.professional.logoDataUrl || null,
      circuit_survey: payload.circuitSurvey,
    };

    if (payload.id) {
      const { data, error } = await this.auth.client
        .from('presupuestos')
        .update(row)
        .eq('id', payload.id)
        .select('*')
        .single();
      if (error) return { row: null, error: error.message };
      return { row: this.mapRow(data as Record<string, unknown>), error: null };
    }

    const { data, error } = await this.auth.client.from('presupuestos').insert(row).select('*').single();
    if (error) return { row: null, error: error.message };
    return { row: this.mapRow(data as Record<string, unknown>), error: null };
  }

  async delete(id: string): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('presupuestos').delete().eq('id', id);
    return { error: error?.message ?? null };
  }

  private mapRow(r: Record<string, unknown>): PresupuestoRow {
    return {
      id: r['id'] as string,
      ownerUserId: r['owner_user_id'] as string,
      referenceCode: (r['reference_code'] as string) ?? null,
      clientName: String(r['client_name'] ?? ''),
      clientPhone: (r['client_phone'] as string) ?? null,
      clientEmail: (r['client_email'] as string) ?? null,
      siteAddress: (r['site_address'] as string) ?? null,
      workDescription: (r['work_description'] as string) ?? null,
      notes: (r['notes'] as string) ?? null,
      items: parseItems(r['items']),
      currency: String(r['currency'] ?? 'ARS'),
      taxPercent: Number(r['tax_percent'] ?? 21),
      discountPercent: Number(r['discount_percent'] ?? 0),
      status: (r['status'] as PresupuestoStatus) ?? 'borrador',
      validUntil: (r['valid_until'] as string) ?? null,
      systemType: parseSystemType(r['system_type']),
      systemTypeOther: (r['system_type_other'] as string) ?? null,
      refrigerant: (r['refrigerant'] as string) ?? null,
      nominalCapacity: (r['nominal_capacity'] as string) ?? null,
      professional: {
        companyName: String(r['company_name'] ?? ''),
        technicianName: String(r['technician_name'] ?? ''),
        technicianPhone: String(r['technician_phone'] ?? ''),
        technicianEmail: String(r['technician_email'] ?? ''),
        technicianLicense: String(r['technician_license'] ?? ''),
        logoDataUrl: (r['logo_data_url'] as string) ?? null,
      },
      circuitSurvey: parseCircuitSurvey(r['circuit_survey']),
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    };
  }
}
