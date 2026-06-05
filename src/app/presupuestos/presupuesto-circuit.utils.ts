import { CIRCUIT_SECTION_DEFS } from './presupuesto-circuit.catalog';
import type {
  CircuitComponentState,
  CircuitSectionState,
  ComponentStatus,
  PresupuestoProfessionalInfo,
  RefrigerationCircuitSurvey,
  RefrigerationSystemType,
} from './presupuesto-circuit.models';

const PROFILE_STORAGE_KEY = 'ar_monitoreo_presupuesto_profile';

export function defaultCircuitSurvey(): RefrigerationCircuitSurvey {
  return {
    sections: CIRCUIT_SECTION_DEFS.map((def) => ({
      key: def.key,
      title: def.title,
      composition: '',
      problemReported: '',
      workProposed: '',
      components: def.components.map((c) => ({
        key: c.key,
        label: c.label,
        present: false,
        status: 'na' as ComponentStatus,
        notes: '',
      })),
    })),
    generalProblem: '',
    generalDiagnosis: '',
  };
}

export function parseCircuitSurvey(raw: unknown): RefrigerationCircuitSurvey {
  const base = defaultCircuitSurvey();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  const sectionsRaw = o['sections'];
  if (!Array.isArray(sectionsRaw)) {
    return {
      ...base,
      generalProblem: String(o['generalProblem'] ?? o['general_problem'] ?? '').trim(),
      generalDiagnosis: String(o['generalDiagnosis'] ?? o['general_diagnosis'] ?? '').trim(),
    };
  }

  const sections = base.sections.map((defSec) => {
    const saved = sectionsRaw.find(
      (s) => (s as Record<string, unknown>)['key'] === defSec.key
    ) as Record<string, unknown> | undefined;
    if (!saved) return { ...defSec };

    const compsRaw = saved['components'];
    const components = defSec.components.map((defComp) => {
      const list = Array.isArray(compsRaw) ? compsRaw : [];
      const c = list.find(
        (x) => (x as Record<string, unknown>)['key'] === defComp.key
      ) as Record<string, unknown> | undefined;
      if (!c) return { ...defComp };
      return {
        ...defComp,
        present: Boolean(c['present']),
        status: parseStatus(c['status']),
        notes: String(c['notes'] ?? '').trim(),
      };
    });

    return {
      ...defSec,
      composition: String(saved['composition'] ?? '').trim(),
      problemReported: String(saved['problemReported'] ?? saved['problem_reported'] ?? '').trim(),
      workProposed: String(saved['workProposed'] ?? saved['work_proposed'] ?? '').trim(),
      components,
    };
  });

  return {
    sections,
    generalProblem: String(o['generalProblem'] ?? o['general_problem'] ?? '').trim(),
    generalDiagnosis: String(o['generalDiagnosis'] ?? o['general_diagnosis'] ?? '').trim(),
  };
}

function parseStatus(v: unknown): ComponentStatus {
  const s = String(v ?? 'na');
  if (s === 'ok' || s === 'falla' || s === 'revisar' || s === 'reemplazar' || s === 'na') return s;
  return 'na';
}

export function parseSystemType(v: unknown): RefrigerationSystemType | '' {
  const s = String(v ?? '');
  if (
    s === 'camara' ||
    s === 'heladera' ||
    s === 'central_frigorifica' ||
    s === 'chiller' ||
    s === 'banco_agua_helada' ||
    s === 'otro'
  ) {
    return s;
  }
  return '';
}

export function activeComponents(sec: CircuitSectionState): CircuitComponentState[] {
  return sec.components.filter((c) => c.present || c.status !== 'na' || c.notes.trim());
}

export function sectionHasContent(sec: CircuitSectionState): boolean {
  return (
    !!sec.composition.trim() ||
    !!sec.problemReported.trim() ||
    !!sec.workProposed.trim() ||
    activeComponents(sec).length > 0
  );
}

export function surveyHasContent(survey: RefrigerationCircuitSurvey): boolean {
  return (
    survey.sections.some(sectionHasContent) ||
    !!survey.generalProblem.trim() ||
    !!survey.generalDiagnosis.trim()
  );
}

export function loadDefaultProfile(): PresupuestoProfessionalInfo | null {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      companyName: String(o['companyName'] ?? '').trim(),
      technicianName: String(o['technicianName'] ?? '').trim(),
      technicianPhone: String(o['technicianPhone'] ?? '').trim(),
      technicianEmail: String(o['technicianEmail'] ?? '').trim(),
      technicianLicense: String(o['technicianLicense'] ?? '').trim(),
      logoDataUrl: typeof o['logoDataUrl'] === 'string' ? o['logoDataUrl'] : null,
    };
  } catch {
    return null;
  }
}

export function saveDefaultProfile(info: PresupuestoProfessionalInfo): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(info));
  } catch {
    /* quota */
  }
}

export function emptyProfessional(): PresupuestoProfessionalInfo {
  return {
    companyName: '',
    technicianName: '',
    technicianPhone: '',
    technicianEmail: '',
    technicianLicense: '',
    logoDataUrl: null,
  };
}

/** Redimensiona logo para guardar (máx. ancho en px). */
export function resizeLogoFile(file: File, maxWidth = 420): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(typeof reader.result === 'string' ? reader.result : null);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(mime, 0.85));
      };
      img.onerror = () => resolve(null);
      img.src = reader.result as string;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function componentStatusLabel(status: ComponentStatus): string {
  const map: Record<ComponentStatus, string> = {
    ok: 'OK',
    falla: 'Falla',
    revisar: 'A revisar',
    reemplazar: 'A reemplazar',
    na: 'N/A',
  };
  return map[status] ?? status;
}
