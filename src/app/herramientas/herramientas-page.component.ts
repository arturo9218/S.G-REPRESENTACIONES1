import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { DeviceStoreService } from '../core/device-store.service';
import {
  DeviceEquipmentFichaRow,
  DeviceEquipmentLogRow,
  EquipmentSheetService,
} from '../core/equipment-sheet.service';
import type {
  DashboardCombistato,
  DashboardDevice,
  DashboardPr500,
} from '../core/models/dashboard.models';
import { CombistatoStoreService } from '../core/combistato-store.service';
import { Pr500StoreService } from '../core/pr500-store.service';
import {
  formatCombistatoImportSummary,
  formatPr500ImportSummary,
  formatPro400ImportSummary,
} from './cloud-import.util';
import { ToastService } from '../core/toast.service';
import { environment } from '../../environments/environment';
import {
  REFRIGERANTS,
  filterRefrigerants,
  refrigerantById,
  refrigerantFichaValue,
  refrigerantIdFromFichaValue,
  refrigerantsGrouped,
} from './refrigerant-pt.data';
import {
  ATM_BAR,
  absBarFromSatTemp,
  evaluateSubcooling,
  evaluateSuperheat,
  formatNum,
  parseDraftNum,
  fromAbsBar,
  satTempFromAbsBar,
  toAbsBar,
  type PressureUnit,
  type SubcoolingResult,
  type SuperheatResult,
} from './refrigerant-pt.utils';
import {
  CHAMBER_DOOR_USAGE,
  CHAMBER_INSULATION_PRESETS,
  CHAMBER_PRODUCT_TYPES,
  CHAMBER_USAGE_PRESETS,
  chamberEvapTempC,
  estimateChamberLoad,
  type ChamberCalcMode,
  type ChamberDoorUsage,
  type ChamberInsulationPreset,
  type ChamberLoadResult,
  type ChamberProductType,
} from './chamber-load.utils';
import { danfossOrificeFichaText, sizeTxv, type TxvSizingResult } from './txv-sizing.utils';
import type { DanfossApplication } from './danfoss-valve-lines.data';
import { DANFOSS_VALVE_LINES } from './danfoss-valve-lines.data';
import { evaluateFilterDeltaT, type FilterDeltaTResult } from './filter-delta-t.utils';
import { refrigerantIdFromPr500Code } from './pr500-refrigerant.util';
import {
  barGToPressure,
  cToTemp,
  kwToPower,
  PRESSURE_UNIT_LABELS,
  POWER_UNIT_LABELS,
  pressureToBarG,
  powerToKw,
  TEMP_UNIT_LABELS,
  tempToC,
  type PowerConvertUnit,
  type PressureConvertUnit,
  type TempConvertUnit,
  type UnitCategory,
} from './unit-convert.utils';

export type HerramientasTab = 'pt' | 'sh' | 'units' | 'camara' | 'txv' | 'visita';

export interface UnitConvertRow {
  label: string;
  value: string;
}

export interface PtTableRow {
  tempC: number;
  pBarG: number;
  pBarA: number;
  pPsiG: number;
}

@Component({
  selector: 'app-herramientas-page',
  templateUrl: './herramientas-page.component.html',
  styleUrls: ['./herramientas-page.component.scss'],
})
export class HerramientasPageComponent implements OnInit, OnDestroy {
  @Output() fichaSaved = new EventEmitter<{ deviceId: string; fichaId: string }>();

  readonly atmBar = ATM_BAR;
  readonly refrigerantCount = REFRIGERANTS.length;
  readonly danfossValveLines = DANFOSS_VALVE_LINES;
  readonly chamberUsagePresets = CHAMBER_USAGE_PRESETS;
  readonly chamberProductTypes = CHAMBER_PRODUCT_TYPES;
  readonly chamberInsulationPresets = CHAMBER_INSULATION_PRESETS;
  readonly chamberDoorUsageOptions = CHAMBER_DOOR_USAGE;

  activeTab: HerramientasTab = 'pt';

  refFilter = '';
  selectedRefId = 'r404a';
  pressureUnit: PressureUnit = 'bar_g';
  lookupTempDraft = '';
  lookupPressureDraft = '';
  lookupTempResult = '';
  lookupPressureResult = '';

  shRefId = 'r404a';
  shPressureDraft = '';
  shPressureUnit: PressureUnit = 'bar_g';
  shTempDraft = '';
  shTargetDraft = '8';

  scPressureDraft = '';
  scTempDraft = '';
  scTargetDraft = '3';

  txvRefId = 'r404a';
  txvCapacityDraft = '';
  txvEvapDraft = '-10';
  txvCondDraft = '35';
  txvShDraft = '8';
  txvScDraft = '3';
  /** TE2 = equalización externa (distribuidor / multicircuito). */
  txvExternalEq = true;
  txvDistributorDropDraft = '1';
  txvApplication: DanfossApplication = 'refrigeracion';

  camCalcMode: ChamberCalcMode = 'completo';
  camLengthDraft = '4';
  camWidthDraft = '3';
  camHeightDraft = '2.5';
  camExteriorDraft = '35';
  camInteriorDraft = '5';
  camProductType: ChamberProductType = 'verdura';
  camInsulation: ChamberInsulationPreset = 'mamposteria';
  camCustomKDraft = '0.85';
  camDoorUsage: ChamberDoorUsage = 'medio';
  camKgDayDraft = '500';
  camProductInDraft = '25';
  camOpHoursDraft = '18';
  camMotorsWDraft = '300';
  camLightsWDraft = '100';
  camPeopleWDraft = '0';
  camMarginDraft = '20';
  camKcalCustomDraft = '110';

  unitCategory: UnitCategory = 'pressure';
  unitValueDraft = '2.5';
  unitPressureFrom: PressureConvertUnit = 'bar_g';
  unitTempFrom: TempConvertUnit = 'c';
  unitPowerFrom: PowerConvertUnit = 'kw';

  filtroInDraft = '';
  filtroOutDraft = '';

  pr500PickId = '';
  pro300PickId = '';
  pro400PickId = '';
  cloudImportHint = '';
  pr500List: DashboardPr500[] = [];
  combistatoList: DashboardCombistato[] = [];

  visitAtDraft = '';
  visitPbDraft = '';
  visitPaDraft = '';
  visitShDraft = '';
  visitScDraft = '';
  visitFilterDtDraft = '';
  visitNoteDraft = '';
  visitLogs: DeviceEquipmentLogRow[] = [];
  visitLogLoading = false;

  /** Guardar en ficha (paneles PRO400 con ficha en nube). */
  fichaDeviceId = '';
  fichaId = '';
  fichaRows: DeviceEquipmentFichaRow[] = [];
  fichaLoading = false;
  fichaSaving = false;
  cloudDevices: DashboardDevice[] = [];

  private subDev?: Subscription;
  private subRoute?: Subscription;
  private subPr500?: Subscription;
  private subCombistato?: Subscription;

  constructor(
    private readonly deviceStore: DeviceStoreService,
    private readonly equipmentSheet: EquipmentSheetService,
    private readonly pr500Store: Pr500StoreService,
    private readonly combistatoStore: CombistatoStoreService,
    private readonly toast: ToastService,
    private readonly route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    this.visitAtDraft = new Date().toISOString().slice(0, 16);
    this.subPr500 = this.pr500Store.pr500s$.subscribe((list) => {
      this.pr500List = list.filter((p) => this.isUuid(p.id));
      if (this.pr500PickId && !this.pr500List.some((p) => p.id === this.pr500PickId)) {
        this.pr500PickId = '';
      }
    });
    this.subCombistato = this.combistatoStore.combistatos$.subscribe((list) => {
      this.combistatoList = list.filter((c) => this.isUuid(c.id));
      if (this.pro300PickId && !this.combistatoList.some((c) => c.id === this.pro300PickId)) {
        this.pro300PickId = '';
      }
    });
    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.cloudDevices = list.filter((d) => d.cloudSynced && this.isUuid(d.id));
      if (this.fichaDeviceId && !this.cloudDevices.some((d) => d.id === this.fichaDeviceId)) {
        this.fichaDeviceId = '';
        this.fichaId = '';
        this.fichaRows = [];
      }
      if (this.pro400PickId && !this.pro400CloudDevices.some((d) => d.id === this.pro400PickId)) {
        this.pro400PickId = '';
      }
    });
    this.subRoute = this.route.queryParamMap.subscribe((params) => {
      void this.applyRouteContext(params.get('deviceId'), params.get('fichaId'), params.get('tab'));
    });
  }

  ngOnDestroy(): void {
    this.subDev?.unsubscribe();
    this.subRoute?.unsubscribe();
    this.subPr500?.unsubscribe();
    this.subCombistato?.unsubscribe();
  }

  get fichaEnabled(): boolean {
    return environment.deviceCloudSync === true && this.cloudDevices.length > 0;
  }

  get refrigerantGroups() {
    return refrigerantsGrouped(this.refFilter);
  }

  get allRefrigerantGroups() {
    return refrigerantsGrouped('');
  }

  get filteredRefrigerantsForSelect() {
    return filterRefrigerants(this.refFilter);
  }

  get selectedRefrigerant() {
    return refrigerantById(this.selectedRefId);
  }

  get shRefrigerant() {
    return refrigerantById(this.shRefId);
  }

  get txvRefrigerant() {
    return refrigerantById(this.txvRefId);
  }

  get ptTableRows(): PtTableRow[] {
    const ref = this.selectedRefrigerant;
    if (!ref) return [];
    return [...ref.points]
      .sort((a, b) => a.t - b.t)
      .map((pt) => ({
        tempC: pt.t,
        pBarA: pt.p,
        pBarG: pt.p - ATM_BAR,
        pPsiG: (pt.p - ATM_BAR) * 14.5038,
      }));
  }

  get superheatResult(): SuperheatResult | null {
    const ref = this.shRefrigerant;
    if (!ref) return null;
    const p = parseFloat(this.shPressureDraft.replace(',', '.'));
    const t = parseFloat(this.shTempDraft.replace(',', '.'));
    const target = parseFloat(this.shTargetDraft.replace(',', '.'));
    const pAbs = toAbsBar(p, this.shPressureUnit);
    if (pAbs == null || !Number.isFinite(t)) return null;
    return evaluateSuperheat(t, pAbs, ref.points, target);
  }

  get subcoolingResult(): SubcoolingResult | null {
    const ref = this.shRefrigerant;
    if (!ref) return null;
    const p = parseFloat(this.scPressureDraft.replace(',', '.'));
    const t = parseFloat(this.scTempDraft.replace(',', '.'));
    const target = parseFloat(this.scTargetDraft.replace(',', '.'));
    const pAbs = toAbsBar(p, this.shPressureUnit);
    if (pAbs == null || !Number.isFinite(t)) return null;
    return evaluateSubcooling(t, pAbs, ref.points, target);
  }

  get chamberLoadResult(): ChamberLoadResult | null {
    const L = parseDraftNum(this.camLengthDraft);
    const A = parseDraftNum(this.camWidthDraft);
    const H = parseDraftNum(this.camHeightDraft);
    const ext = parseDraftNum(this.camExteriorDraft);
    const int = parseDraftNum(this.camInteriorDraft);
    const customK = parseDraftNum(this.camCustomKDraft);
    const kgDay = parseDraftNum(this.camKgDayDraft);
    const prodIn = parseDraftNum(this.camProductInDraft);
    const opH = parseDraftNum(this.camOpHoursDraft);
    const motorsW = parseDraftNum(this.camMotorsWDraft);
    const lightsW = parseDraftNum(this.camLightsWDraft);
    const peopleW = parseDraftNum(this.camPeopleWDraft);
    const margin = parseDraftNum(this.camMarginDraft);
    const customKcal = parseDraftNum(this.camKcalCustomDraft);
    if (L == null || A == null || H == null || ext == null || int == null) return null;
    return estimateChamberLoad({
      lengthM: L,
      widthM: A,
      heightM: H,
      exteriorTempC: ext,
      interiorTempC: int,
      productType: this.camProductType,
      insulation: this.camInsulation,
      customKKcalHm2C: this.camInsulation === 'custom_u' ? customK : undefined,
      doorUsage: this.camDoorUsage,
      kgProductPerDay: Number.isFinite(kgDay) ? kgDay : 0,
      productInTempC: Number.isFinite(prodIn) ? prodIn : ext,
      opHoursPerDay: Number.isFinite(opH) ? opH : 18,
      motorsW: Number.isFinite(motorsW) ? motorsW : 0,
      lightsW: Number.isFinite(lightsW) ? lightsW : 0,
      peopleHeatW: Number.isFinite(peopleW) ? peopleW : 0,
      safetyMarginPct: Number.isFinite(margin) ? margin : 20,
      mode: this.camCalcMode,
      kcalPerM3Custom: this.camCalcMode === 'rapido' ? customKcal : undefined,
    });
  }

  get filterDeltaResult(): FilterDeltaTResult | null {
    const tin = parseFloat(this.filtroInDraft.replace(',', '.'));
    const tout = parseFloat(this.filtroOutDraft.replace(',', '.'));
    return evaluateFilterDeltaT(tin, tout);
  }

  get unitConvertRows(): UnitConvertRow[] {
    const v = parseFloat(this.unitValueDraft.replace(',', '.'));
    if (!Number.isFinite(v)) return [];
    if (this.unitCategory === 'pressure') {
      const barG = pressureToBarG(v, this.unitPressureFrom);
      if (barG == null) return [];
      return (Object.keys(PRESSURE_UNIT_LABELS) as PressureConvertUnit[]).map((u) => {
        const out = barGToPressure(barG, u);
        return {
          label: PRESSURE_UNIT_LABELS[u],
          value: out != null ? formatNum(out, u === 'kpa_g' ? 1 : 2) : '—',
        };
      });
    }
    if (this.unitCategory === 'temp') {
      const c = tempToC(v, this.unitTempFrom);
      if (c == null) return [];
      return (Object.keys(TEMP_UNIT_LABELS) as TempConvertUnit[]).map((u) => {
        const out = cToTemp(c, u);
        return {
          label: TEMP_UNIT_LABELS[u],
          value: out != null ? formatNum(out, 1) : '—',
        };
      });
    }
    const kw = powerToKw(v, this.unitPowerFrom);
    if (kw == null) return [];
    return (Object.keys(POWER_UNIT_LABELS) as PowerConvertUnit[]).map((u) => {
      const out = kwToPower(kw, u);
      return {
        label: POWER_UNIT_LABELS[u],
        value: out != null ? formatNum(out, u === 'btu_h' ? 0 : 2) : '—',
      };
    });
  }

  get hasCloudImport(): boolean {
    return (
      this.pr500List.length > 0 ||
      this.combistatoList.length > 0 ||
      this.pro400CloudDevices.length > 0
    );
  }

  /** Paneles PRO400 en nube con al menos una temperatura reciente. */
  get pro400CloudDevices(): DashboardDevice[] {
    return this.cloudDevices.filter(
      (d) =>
        d.equipmentKind === 'pro400' &&
        (d.temperatureC != null || d.temperature2C != null)
    );
  }

  get selectedPr500(): DashboardPr500 | undefined {
    return this.pr500List.find((p) => p.id === this.pr500PickId);
  }

  get selectedCombistato(): DashboardCombistato | undefined {
    return this.combistatoList.find((c) => c.id === this.pro300PickId);
  }

  get selectedPro400(): DashboardDevice | undefined {
    return this.pro400CloudDevices.find((d) => d.id === this.pro400PickId);
  }

  get txvResult(): TxvSizingResult | null {
    const ref = this.txvRefrigerant;
    if (!ref) return null;
    const kw = parseFloat(this.txvCapacityDraft.replace(',', '.'));
    const te = parseFloat(this.txvEvapDraft.replace(',', '.'));
    const tc = parseFloat(this.txvCondDraft.replace(',', '.'));
    const sh = parseFloat(this.txvShDraft.replace(',', '.'));
    const sc = parseFloat(this.txvScDraft.replace(',', '.'));
    const dp = parseFloat(this.txvDistributorDropDraft.replace(',', '.'));
    return sizeTxv(
      {
        refrigerantId: ref.id,
        capacityKw: kw,
        evapTempC: te,
        condTempC: tc,
        superheatK: sh,
        subcoolingK: sc,
        externalEqualization: this.txvExternalEq,
        distributorDropBar: this.txvExternalEq && Number.isFinite(dp) ? dp : 0,
        application: this.txvApplication,
      },
      ref.points
    );
  }

  setTab(tab: HerramientasTab): void {
    this.activeTab = tab;
  }

  applyChamberLoadToTxv(): void {
    const load = this.chamberLoadResult;
    if (!load) {
      this.toast.error('Completá dimensiones y temperaturas válidas.');
      return;
    }
    this.txvCapacityDraft = String(Math.round(load.kw * 100) / 100);
    this.txvEvapDraft = String(chamberEvapTempC(load.interiorTempC, this.camProductType));
    this.txvCondDraft = String(load.exteriorTempC);
    this.activeTab = 'txv';
    this.toast.success(`${load.kw.toFixed(2)} kW copiados al dimensionado Danfoss.`);
  }

  onRefFilterChange(): void {
    const visible = this.filteredRefrigerantsForSelect;
    if (visible.length && !visible.some((r) => r.id === this.selectedRefId)) {
      this.selectedRefId = visible[0].id;
    }
  }

  onLookupTemp(): void {
    const ref = this.selectedRefrigerant;
    if (!ref) return;
    const t = parseFloat(this.lookupTempDraft.replace(',', '.'));
    if (!Number.isFinite(t)) {
      this.lookupTempResult = 'Ingresá una temperatura válida (°C).';
      return;
    }
    const pAbs = absBarFromSatTemp(ref.points, t);
    if (pAbs == null) {
      this.lookupTempResult = 'Temperatura fuera del rango de la tabla.';
      return;
    }
    const display = fromAbsBar(pAbs, this.pressureUnit);
    this.lookupTempResult = `A ${formatNum(t, 1)} °C → ${formatNum(display, 2)} ${this.unitLabel(this.pressureUnit)} (sat.)`;
  }

  onLookupPressure(): void {
    const ref = this.selectedRefrigerant;
    if (!ref) return;
    const p = parseFloat(this.lookupPressureDraft.replace(',', '.'));
    if (!Number.isFinite(p)) {
      this.lookupPressureResult = 'Ingresá una presión válida.';
      return;
    }
    const pAbs = toAbsBar(p, this.pressureUnit);
    if (pAbs == null) {
      this.lookupPressureResult = 'Presión inválida.';
      return;
    }
    const t = satTempFromAbsBar(ref.points, pAbs);
    if (t == null) {
      this.lookupPressureResult = 'Presión fuera del rango de la tabla.';
      return;
    }
    this.lookupPressureResult = `A ${formatNum(p, 2)} ${this.unitLabel(this.pressureUnit)} → ${formatNum(t, 1)} °C (sat.)`;
  }

  applyPr500ToSuperheat(): void {
    const p = this.selectedPr500;
    if (!p) {
      this.toast.error('Elegí un PR500.');
      return;
    }
    const refId = refrigerantIdFromPr500Code(p.refrigerantCode);
    if (refId) {
      this.shRefId = refId;
      this.scPressureDraft = this.scPressureDraft || this.shPressureDraft;
    }
    if (p.lastPressureBar != null && Number.isFinite(p.lastPressureBar)) {
      this.shPressureDraft = String(Math.round(p.lastPressureBar * 100) / 100);
      this.shPressureUnit = 'bar_g';
    }
    if (p.lastTempSuctionC != null && Number.isFinite(p.lastTempSuctionC)) {
      this.shTempDraft = String(Math.round(p.lastTempSuctionC * 10) / 10);
    }
    this.cloudImportHint = formatPr500ImportSummary(p);
    if (!p.lastPressureBar && !p.lastTempSuctionC) {
      this.toast.error('Sin lectura reciente de presión o temperatura en ese PR500.');
      return;
    }
    this.activeTab = 'sh';
    this.toast.success('Lectura del PR500 aplicada (opcional).');
  }

  /** PRO300: solo temperaturas de sonda; no reemplaza presión de manifold. */
  applyPro300Temps(): void {
    const c = this.selectedCombistato;
    if (!c) {
      this.toast.error('Elegí un PRO300.');
      return;
    }
    if (c.lastTemp1C == null && c.lastTemp2C == null) {
      this.toast.error('Sin temperaturas recientes en ese PRO300.');
      return;
    }
    if (c.lastTemp1C != null && Number.isFinite(c.lastTemp1C)) {
      this.camInteriorDraft = String(Math.round(c.lastTemp1C * 10) / 10);
    }
    this.cloudImportHint = formatCombistatoImportSummary(c);
    this.toast.success('Temperaturas del PRO300 aplicadas (S1 → cámara; ver nota).');
  }

  applyPro400Temps(): void {
    const d = this.selectedPro400;
    if (!d) {
      this.toast.error('Elegí un panel PRO400.');
      return;
    }
    if (d.temperatureC == null && d.temperature2C == null) {
      this.toast.error('Sin lecturas de temperatura en ese panel.');
      return;
    }
    if (d.temperatureC != null && Number.isFinite(d.temperatureC)) {
      this.camInteriorDraft = String(Math.round(d.temperatureC * 10) / 10);
    }
    this.cloudImportHint = formatPro400ImportSummary(d);
    this.toast.success('Temperaturas del PRO400 aplicadas (opcional).');
  }

  appendCloudTempsToVisit(): void {
    const lines: string[] = [];
    const pr = this.selectedPr500;
    const cb = this.selectedCombistato;
    const dev = this.selectedPro400;
    if (pr) lines.push(`PR500: ${formatPr500ImportSummary(pr)}`);
    if (cb) lines.push(`PRO300: ${formatCombistatoImportSummary(cb)}`);
    if (dev) lines.push(`PRO400: ${formatPro400ImportSummary(dev)}`);
    if (!lines.length) {
      this.toast.error('Elegí al menos un equipo en la sección opcional de nube.');
      return;
    }
    const block = lines.join('\n');
    this.visitNoteDraft = this.visitNoteDraft.trim()
      ? `${this.visitNoteDraft.trim()}\n${block}`
      : block;
    this.toast.success('Referencia de nube agregada a observaciones.');
  }

  async onFichaIdChange(): Promise<void> {
    await this.loadVisitLogs();
  }

  async loadVisitLogs(): Promise<void> {
    this.visitLogs = [];
    if (!this.fichaDeviceId || !this.fichaId) return;
    this.visitLogLoading = true;
    const { rows, error } = await this.equipmentSheet.listLog(this.fichaDeviceId, this.fichaId);
    this.visitLogLoading = false;
    if (error) {
      this.toast.error(`No se pudo cargar el historial: ${error}`);
      return;
    }
    this.visitLogs = rows;
  }

  async saveFieldVisit(): Promise<void> {
    if (!this.fichaDeviceId || !this.fichaId) {
      this.toast.error('Elegí panel y ficha de equipo.');
      return;
    }
    const note = this.buildVisitNote();
    if (!note.trim()) {
      this.toast.error('Agregá al menos una medición u observación.');
      return;
    }
    const occurred = this.visitAtDraft
      ? new Date(this.visitAtDraft).toISOString()
      : new Date().toISOString();

    const { error: logErr } = await this.equipmentSheet.insertLog(
      this.fichaDeviceId,
      this.fichaId,
      occurred,
      note
    );
    if (logErr) {
      this.toast.error(`No se pudo guardar la visita: ${logErr}`);
      return;
    }

    const ficha = this.fichaRows.find((f) => f.id === this.fichaId);
    if (ficha) {
      const patch: Partial<DeviceEquipmentFichaRow> = {};
      const pb = parseFloat(this.visitPbDraft.replace(',', '.'));
      const pa = parseFloat(this.visitPaDraft.replace(',', '.'));
      const sh = parseFloat(this.visitShDraft.replace(',', '.'));
      const sc = parseFloat(this.visitScDraft.replace(',', '.'));
      if (Number.isFinite(pb)) patch.suctionPressureBar = Math.round(pb * 100) / 100;
      if (Number.isFinite(pa)) patch.dischargePressureBar = Math.round(pa * 100) / 100;
      if (Number.isFinite(sh)) patch.superheatC = Math.round(sh * 10) / 10;
      if (Number.isFinite(sc)) patch.subcoolingC = Math.round(sc * 10) / 10;
      if (Object.keys(patch).length > 0) {
        await this.equipmentSheet.upsertFicha({ ...ficha, ...patch, deviceId: this.fichaDeviceId });
      }
    }

    this.toast.success('Visita registrada en la ficha.');
    this.visitNoteDraft = '';
    this.fichaSaved.emit({ deviceId: this.fichaDeviceId, fichaId: this.fichaId });
    await this.loadVisitLogs();
    await this.onFichaDeviceChange();
    if (this.fichaRows.some((f) => f.id === this.fichaId)) {
      /* keep */
    } else if (this.fichaRows.length) {
      this.fichaId = this.fichaRows[0].id;
    }
  }

  async deleteVisitLog(row: DeviceEquipmentLogRow): Promise<void> {
    if (!window.confirm('¿Eliminar este registro de visita?')) return;
    const { error } = await this.equipmentSheet.deleteLog(row.id);
    if (error) {
      this.toast.error(error);
      return;
    }
    await this.loadVisitLogs();
  }

  fillVisitFromCalculators(): void {
    const sh = this.superheatResult;
    const sc = this.subcoolingResult;
    const pSh = parseFloat(this.shPressureDraft.replace(',', '.'));
    const pAbs = toAbsBar(pSh, this.shPressureUnit);
    const pb = pAbs != null ? fromAbsBar(pAbs, 'bar_g') : null;
    if (pb != null) this.visitPbDraft = String(Math.round(pb * 100) / 100);
    if (sh) this.visitShDraft = String(Math.round(sh.superheatC * 10) / 10);
    if (sc && sc.severity !== 'negative') {
      this.visitScDraft = String(Math.round(sc.subcoolingC * 10) / 10);
    }
    const fd = this.filterDeltaResult;
    if (fd) this.visitFilterDtDraft = String(Math.round(fd.deltaC * 10) / 10);
    this.toast.success('Mediciones copiadas desde las calculadoras.');
  }

  visitLogLabel(iso: string): string {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch {
      return iso;
    }
  }

  async onFichaDeviceChange(): Promise<void> {
    this.fichaId = '';
    this.fichaRows = [];
    this.visitLogs = [];
    if (!this.fichaDeviceId) return;
    this.fichaLoading = true;
    const { rows, error } = await this.equipmentSheet.listFichas(this.fichaDeviceId);
    this.fichaLoading = false;
    if (error) {
      this.toast.error(`No se pudieron cargar fichas: ${error}`);
      return;
    }
    this.fichaRows = rows;
    if (rows.length === 1) {
      this.fichaId = rows[0].id;
      await this.loadVisitLogs();
    }
  }

  async saveToFicha(mode: 'sh' | 'txv' | 'tua' | 'te5'): Promise<void> {
    if (!this.fichaDeviceId || !this.fichaId) {
      this.toast.error('Elegí panel y ficha de equipo.');
      return;
    }
    const ficha = this.fichaRows.find((f) => f.id === this.fichaId);
    if (!ficha) {
      this.toast.error('Ficha no encontrada.');
      return;
    }

    let refId = mode === 'sh' ? this.shRefId : this.txvRefId;
    const ref = refrigerantById(refId);
    if (!ref) return;

    const patch: Partial<DeviceEquipmentFichaRow> = {
      refrigerant: refrigerantFichaValue(ref),
      expansionType: ficha.expansionType ?? 'valve',
    };

    if (mode === 'sh') {
      const sh = this.superheatResult;
      const sc = this.subcoolingResult;
      const pSh = parseFloat(this.shPressureDraft.replace(',', '.'));
      const pAbsSh = toAbsBar(pSh, this.shPressureUnit);
      const pBarG = pAbsSh != null ? fromAbsBar(pAbsSh, 'bar_g') : null;
      if (!sh && !sc) {
        this.toast.error('Completá al menos recalentamiento o subenfriamiento con valores válidos.');
        return;
      }
      if (sh) {
        patch.superheatC = Math.round(sh.superheatC * 10) / 10;
        if (pBarG != null && Number.isFinite(pBarG)) {
          patch.suctionPressureBar = Math.round(pBarG * 100) / 100;
        }
      }
      if (sc && sc.severity !== 'negative') {
        patch.subcoolingC = Math.round(sc.subcoolingC * 10) / 10;
      } else if (sc?.severity === 'negative') {
        this.toast.error('Subenfriamiento negativo: revisá medición antes de guardar en ficha.');
        return;
      }
    } else if (mode === 'tua') {
      const tua = this.txvResult?.tuaAlternative;
      if (!tua) {
        this.toast.error('No hay alternativa TUA calculada para estas condiciones.');
        return;
      }
      patch.expansionType = 'valve';
      patch.expansionOrificeText = tua.fichaText;
      if (!ficha.expansionValveBrand?.trim()) patch.expansionValveBrand = 'Danfoss';
      if (!ficha.expansionValveModel?.trim()) patch.expansionValveModel = tua.valveBody;
    } else if (mode === 'te5') {
      const te5 = this.txvResult?.te5Alternative;
      if (!te5) {
        this.toast.error('No hay recomendación TE5/TEX para estas condiciones (Te debe estar entre −40 y +10 °C).');
        return;
      }
      patch.expansionType = 'valve';
      patch.expansionOrificeText = te5.fichaText;
      if (!ficha.expansionValveBrand?.trim()) patch.expansionValveBrand = 'Danfoss';
      if (!ficha.expansionValveModel?.trim()) patch.expansionValveModel = te5.valveBody;
    } else {
      const txv = this.txvResult;
      if (!txv) {
        this.toast.error('Completá capacidad y temperaturas válidas (Tc > Te + 5 °C).');
        return;
      }
      patch.expansionType = 'valve';
      patch.expansionOrificeText = danfossOrificeFichaText(txv);
      if (!ficha.expansionValveBrand?.trim()) patch.expansionValveBrand = 'Danfoss';
      if (!ficha.expansionValveModel?.trim()) {
        patch.expansionValveModel =
          txv.danfoss.valveLine === 't2_te2'
            ? txv.danfoss.valveBody
            : txv.danfoss.valveLine === 'tr6'
              ? 'TR6'
              : txv.danfoss.valveBody;
      }
    }

    this.fichaSaving = true;
    const { error } = await this.equipmentSheet.upsertFicha({
      ...ficha,
      ...patch,
      deviceId: this.fichaDeviceId,
    });
    this.fichaSaving = false;

    if (error) {
      this.toast.error(`No se pudo guardar: ${error}`);
      return;
    }
    this.toast.success('Datos guardados en la ficha del equipo.');
    this.fichaSaved.emit({ deviceId: this.fichaDeviceId, fichaId: this.fichaId });
    await this.onFichaDeviceChange();
    if (this.fichaRows.some((f) => f.id === this.fichaId)) {
      /* keep selection */
    } else if (this.fichaRows.length) {
      this.fichaId = this.fichaRows[0].id;
    }
  }

  unitLabel(unit: PressureUnit): string {
    switch (unit) {
      case 'bar_g':
        return 'bar g';
      case 'bar_a':
        return 'bar a';
      case 'psi_g':
        return 'psi g';
      case 'psi_a':
        return 'psi a';
    }
  }

  fmt(v: number | null | undefined, digits = 1): string {
    return formatNum(v ?? null, digits);
  }

  private isUuid(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  }

  private async applyRouteContext(
    deviceId: string | null,
    fichaId: string | null,
    tab: string | null
  ): Promise<void> {
    if (
      tab === 'txv' ||
      tab === 'sh' ||
      tab === 'pt' ||
      tab === 'camara' ||
      tab === 'units' ||
      tab === 'visita'
    ) {
      this.activeTab = tab;
    }
    if (!deviceId || !this.isUuid(deviceId)) return;

    this.fichaDeviceId = deviceId;
    await this.onFichaDeviceChange();

    if (fichaId && this.fichaRows.some((f) => f.id === fichaId)) {
      this.fichaId = fichaId;
      this.prefillFromFicha(this.fichaRows.find((f) => f.id === fichaId)!);
    } else if (this.fichaRows.length === 1) {
      this.prefillFromFicha(this.fichaRows[0]);
    }
  }

  private prefillFromFicha(ficha: DeviceEquipmentFichaRow): void {
    const refId = refrigerantIdFromFichaValue(ficha.refrigerant);
    if (refId) {
      this.txvRefId = refId;
      this.shRefId = refId;
      this.selectedRefId = refId;
    }
    if (ficha.subcoolingC != null && Number.isFinite(ficha.subcoolingC)) {
      this.txvScDraft = String(ficha.subcoolingC);
    }
    if (ficha.superheatC != null && Number.isFinite(ficha.superheatC)) {
      this.txvShDraft = String(ficha.superheatC);
      this.shTargetDraft = String(ficha.superheatC);
    }
    if (ficha.suctionPressureBar != null && Number.isFinite(ficha.suctionPressureBar)) {
      this.shPressureDraft = String(ficha.suctionPressureBar);
    }
    void this.loadVisitLogs();
  }

  private buildVisitNote(): string {
    const lines: string[] = ['Visita de campo'];
    const pb = this.visitPbDraft.trim();
    const pa = this.visitPaDraft.trim();
    const sh = this.visitShDraft.trim();
    const sc = this.visitScDraft.trim();
    const fd = this.visitFilterDtDraft.trim();
    if (pb || pa) {
      lines.push(`Presiones: baja ${pb || '—'} bar g · alta ${pa || '—'} bar g`);
    }
    if (sh || sc) {
      lines.push(`Recalent. ${sh || '—'} K · Subenf. ${sc || '—'} K`);
    }
    if (fd) lines.push(`Filtro ΔT: ${fd} K`);
    const obs = this.visitNoteDraft.trim();
    if (obs) lines.push(`Obs: ${obs}`);
    return lines.join('\n');
  }
}
