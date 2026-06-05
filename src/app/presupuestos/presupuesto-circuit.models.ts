export type RefrigerationSystemType =
  | 'camara'
  | 'heladera'
  | 'central_frigorifica'
  | 'chiller'
  | 'banco_agua_helada'
  | 'otro';

export type ComponentStatus = 'ok' | 'falla' | 'revisar' | 'reemplazar' | 'na';

export interface CircuitComponentState {
  key: string;
  label: string;
  present: boolean;
  status: ComponentStatus;
  notes: string;
}

export interface CircuitSectionState {
  key: string;
  title: string;
  composition: string;
  problemReported: string;
  workProposed: string;
  components: CircuitComponentState[];
}

export interface RefrigerationCircuitSurvey {
  sections: CircuitSectionState[];
  generalProblem: string;
  generalDiagnosis: string;
}

export interface PresupuestoProfessionalInfo {
  companyName: string;
  technicianName: string;
  technicianPhone: string;
  technicianEmail: string;
  technicianLicense: string;
  logoDataUrl: string | null;
}
