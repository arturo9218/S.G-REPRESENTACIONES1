import type {
  DashboardCombistato,
  DashboardDatalogger,
  DashboardDevice,
  DashboardPr500,
  DashboardPro400,
} from './models/dashboard.models';

export type EquipmentFichaKind = 'device' | 'pr500' | 'combistato' | 'datalogger';

export interface EquipmentFichaTarget {
  kind: EquipmentFichaKind;
  id: string;
  name: string;
  location: string;
  moduleId?: string;
  typeLabel: string;
}

export interface EquipmentFichaRef {
  kind: EquipmentFichaKind;
  entityId: string;
}

const KINDS: EquipmentFichaKind[] = ['device', 'pr500', 'combistato', 'datalogger'];

export function equipmentFichaTargetKey(t: Pick<EquipmentFichaTarget, 'kind' | 'id'>): string {
  return `${t.kind}:${t.id}`;
}

export function equipmentFichaRefFromTarget(t: Pick<EquipmentFichaTarget, 'kind' | 'id'>): EquipmentFichaRef {
  return { kind: t.kind, entityId: t.id };
}

export function parseEquipmentFichaTargetKey(
  key: string | null | undefined
): EquipmentFichaRef | null {
  if (!key) return null;
  const sep = key.indexOf(':');
  if (sep <= 0) return null;
  const kind = key.slice(0, sep) as EquipmentFichaKind;
  const entityId = key.slice(sep + 1);
  if (!KINDS.includes(kind) || !entityId) return null;
  return { kind, entityId };
}

export function equipmentFichaKindLabel(kind: EquipmentFichaKind): string {
  switch (kind) {
    case 'device':
      return 'Panel';
    case 'pr500':
      return 'PR500';
    case 'combistato':
      return 'PRO300';
    case 'datalogger':
      return 'Datalogger';
    default:
      return kind;
  }
}

export function buildEquipmentFichaTargets(input: {
  devices: DashboardDevice[];
  pro400s: DashboardPro400[];
  combistatos: DashboardCombistato[];
  pr500s: DashboardPr500[];
  dataloggers: DashboardDatalogger[];
  cloudSync: boolean;
  isUuid: (id: string) => boolean;
}): EquipmentFichaTarget[] {
  if (!input.cloudSync) return [];
  const out: EquipmentFichaTarget[] = [];

  for (const d of input.devices) {
    if (d.cloudSynced && input.isUuid(d.id)) {
      out.push({
        kind: 'device',
        id: d.id,
        name: d.name,
        location: d.location,
        moduleId: d.moduleId,
        typeLabel: 'Panel',
      });
    }
  }
  for (const p of input.pro400s) {
    if (input.isUuid(p.id)) {
      out.push({
        kind: 'device',
        id: p.id,
        name: p.name,
        location: p.location,
        moduleId: p.moduleId,
        typeLabel: 'PRO400',
      });
    }
  }
  for (const c of input.combistatos) {
    if (input.isUuid(c.id)) {
      out.push({
        kind: 'combistato',
        id: c.id,
        name: c.name,
        location: c.location,
        moduleId: c.moduleId,
        typeLabel: 'PRO300',
      });
    }
  }
  for (const p of input.pr500s) {
    if (input.isUuid(p.id)) {
      out.push({
        kind: 'pr500',
        id: p.id,
        name: p.name,
        location: p.location,
        moduleId: p.moduleId,
        typeLabel: 'PR500',
      });
    }
  }
  for (const d of input.dataloggers) {
    if (input.isUuid(d.id)) {
      out.push({
        kind: 'datalogger',
        id: d.id,
        name: d.name,
        location: d.location,
        moduleId: d.moduleId,
        typeLabel: 'Datalogger',
      });
    }
  }

  out.sort((a, b) => {
    const ta = a.typeLabel.localeCompare(b.typeLabel, 'es');
    if (ta !== 0) return ta;
    return a.name.localeCompare(b.name, 'es');
  });
  return out;
}

export function findEquipmentFichaTarget(
  targets: EquipmentFichaTarget[],
  ref: EquipmentFichaRef | null | undefined
): EquipmentFichaTarget | null {
  if (!ref) return null;
  return targets.find((t) => t.kind === ref.kind && t.id === ref.entityId) ?? null;
}

export function equipmentFichaTargetOptionLabel(t: EquipmentFichaTarget): string {
  const loc = t.location?.trim() || 'Sin ubicación';
  return `[${t.typeLabel}] ${t.name} — ${loc}`;
}
