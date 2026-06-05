import type { CombistatoPhase, DashboardCombistato, DashboardDevice, DashboardPr500 } from '../core/models/dashboard.models';
import { pr500RefrigerantLabel } from './pr500-refrigerant.util';

export function combistatoPhaseLabel(phase: CombistatoPhase | null | undefined): string {
  switch (phase) {
    case 'normal':
      return 'Normal';
    case 'defrost':
      return 'Deshielo';
    case 'drip':
      return 'Goteo';
    case 'post_defrost':
      return 'Post-deshielo';
    case 'boot':
      return 'Arranque';
    case 'emerg':
      return 'Emergencia';
    case 'off':
      return 'Apagado';
    default:
      return '—';
  }
}

export function formatPr500ImportSummary(p: DashboardPr500): string {
  const parts: string[] = [pr500RefrigerantLabel(p.refrigerantCode)];
  if (p.lastPressureBar != null && Number.isFinite(p.lastPressureBar)) {
    parts.push(
      p.pressureDisplayPsi
        ? `P succión ≈ ${(p.lastPressureBar * 14.5038).toFixed(1)} psi g`
        : `P succión ≈ ${p.lastPressureBar.toFixed(2)} bar g`
    );
  }
  if (p.lastTempSuctionC != null && Number.isFinite(p.lastTempSuctionC)) {
    parts.push(`T succión ${p.lastTempSuctionC.toFixed(1)} °C`);
  }
  if (p.superheatEnabled && p.lastSuperheatC != null && Number.isFinite(p.lastSuperheatC)) {
    parts.push(`Rec. en equipo: ${p.lastSuperheatC.toFixed(1)} °C`);
  }
  return parts.join(' · ');
}

export function formatCombistatoImportSummary(c: DashboardCombistato): string {
  const parts: string[] = [];
  if (c.lastTemp1C != null && Number.isFinite(c.lastTemp1C)) {
    parts.push(`S1 (ambiente) ${c.lastTemp1C.toFixed(1)} °C`);
  }
  if (c.lastTemp2C != null && Number.isFinite(c.lastTemp2C)) {
    parts.push(`S2 (evap./deshielo) ${c.lastTemp2C.toFixed(1)} °C`);
  }
  parts.push(`Fase: ${combistatoPhaseLabel(c.lastPhase)}`);
  if (c.lastCompOn != null) parts.push(`Comp. ${c.lastCompOn ? 'ON' : 'OFF'}`);
  if (c.lastFanOn != null) parts.push(`Vent. ${c.lastFanOn ? 'ON' : 'OFF'}`);
  if (c.lastDefrostOn != null) parts.push(`Desh. ${c.lastDefrostOn ? 'ON' : 'OFF'}`);
  return parts.join(' · ');
}

export function formatPro400ImportSummary(d: DashboardDevice): string {
  const s1 = d.sensor1Label?.trim() || 'Sonda 1';
  const parts: string[] = [];
  if (d.temperatureC != null && Number.isFinite(d.temperatureC)) {
    parts.push(`${s1}: ${d.temperatureC.toFixed(1)} °C`);
  }
  if (d.temperature2C != null && Number.isFinite(d.temperature2C)) {
    const s2 = d.sensor2Label?.trim() || 'Sonda 2';
    parts.push(`${s2}: ${d.temperature2C.toFixed(1)} °C`);
  }
  if (d.lastPhase) parts.push(`Fase: ${combistatoPhaseLabel(d.lastPhase)}`);
  if (d.lastCompOn != null) parts.push(`Comp. ${d.lastCompOn ? 'ON' : 'OFF'}`);
  if (d.lastDefrostOn != null) parts.push(`Desh. ${d.lastDefrostOn ? 'ON' : 'OFF'}`);
  return parts.join(' · ');
}
