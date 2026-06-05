import type {
  PresupuestoProfessionalInfo,
  RefrigerationCircuitSurvey,
  RefrigerationSystemType,
} from './presupuesto-circuit.models';

export type PresupuestoStatus = 'borrador' | 'enviado' | 'aceptado' | 'rechazado';

export type { PresupuestoProfessionalInfo, RefrigerationCircuitSurvey, RefrigerationSystemType };

export interface PresupuestoLineItem {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

export interface PresupuestoRow {
  id: string;
  ownerUserId: string;
  referenceCode: string | null;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  siteAddress: string | null;
  workDescription: string | null;
  notes: string | null;
  items: PresupuestoLineItem[];
  currency: string;
  taxPercent: number;
  discountPercent: number;
  status: PresupuestoStatus;
  validUntil: string | null;
  systemType: RefrigerationSystemType | '';
  systemTypeOther: string | null;
  refrigerant: string | null;
  nominalCapacity: string | null;
  professional: PresupuestoProfessionalInfo;
  circuitSurvey: RefrigerationCircuitSurvey;
  createdAt: string;
  updatedAt: string;
}

export interface PresupuestoTotals {
  subtotal: number;
  discountAmount: number;
  taxable: number;
  taxAmount: number;
  total: number;
}
