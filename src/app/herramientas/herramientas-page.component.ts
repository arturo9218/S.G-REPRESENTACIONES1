import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { DeviceStoreService } from '../core/device-store.service';
import {
  DeviceEquipmentFichaRow,
  EquipmentSheetService,
} from '../core/equipment-sheet.service';
import type { DashboardDevice } from '../core/models/dashboard.models';
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
  fromAbsBar,
  satTempFromAbsBar,
  toAbsBar,
  type PressureUnit,
  type SubcoolingResult,
  type SuperheatResult,
} from './refrigerant-pt.utils';
import {
  CHAMBER_USAGE_PRESETS,
  chamberEvapTempC,
  estimateChamberLoad,
  type ChamberLoadResult,
  type ChamberUsagePreset,
} from './chamber-load.utils';
import { danfossOrificeFichaText, sizeTxv, type TxvSizingResult } from './txv-sizing.utils';
import type { DanfossApplication } from './danfoss-valve-lines.data';
import { DANFOSS_VALVE_LINES } from './danfoss-valve-lines.data';

export type HerramientasTab = 'pt' | 'sh' | 'camara' | 'txv';

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

  camLengthDraft = '5';
  camWidthDraft = '4';
  camHeightDraft = '2.8';
  camExteriorDraft = '35';
  camInteriorDraft = '2';
  camUsage: ChamberUsagePreset = 'media_verduras';
  camKcalCustomDraft = '110';

  /** Guardar en ficha (paneles PRO400 con ficha en nube). */
  fichaDeviceId = '';
  fichaId = '';
  fichaRows: DeviceEquipmentFichaRow[] = [];
  fichaLoading = false;
  fichaSaving = false;
  cloudDevices: DashboardDevice[] = [];

  private subDev?: Subscription;
  private subRoute?: Subscription;

  constructor(
    private readonly deviceStore: DeviceStoreService,
    private readonly equipmentSheet: EquipmentSheetService,
    private readonly toast: ToastService,
    private readonly route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    this.subDev = this.deviceStore.devices$.subscribe((list) => {
      this.cloudDevices = list.filter((d) => d.cloudSynced && this.isUuid(d.id));
      if (this.fichaDeviceId && !this.cloudDevices.some((d) => d.id === this.fichaDeviceId)) {
        this.fichaDeviceId = '';
        this.fichaId = '';
        this.fichaRows = [];
      }
    });
    this.subRoute = this.route.queryParamMap.subscribe((params) => {
      void this.applyRouteContext(params.get('deviceId'), params.get('fichaId'), params.get('tab'));
    });
  }

  ngOnDestroy(): void {
    this.subDev?.unsubscribe();
    this.subRoute?.unsubscribe();
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
    const L = parseFloat(this.camLengthDraft.replace(',', '.'));
    const A = parseFloat(this.camWidthDraft.replace(',', '.'));
    const H = parseFloat(this.camHeightDraft.replace(',', '.'));
    const ext = parseFloat(this.camExteriorDraft.replace(',', '.'));
    const int = parseFloat(this.camInteriorDraft.replace(',', '.'));
    const customKcal = parseFloat(this.camKcalCustomDraft.replace(',', '.'));
    return estimateChamberLoad({
      lengthM: L,
      widthM: A,
      heightM: H,
      exteriorTempC: ext,
      interiorTempC: int,
      usage: this.camUsage,
      kcalPerM3Custom: this.camUsage === 'custom' ? customKcal : undefined,
    });
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
    this.txvEvapDraft = String(chamberEvapTempC(load.interiorTempC, this.camUsage));
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

  async onFichaDeviceChange(): Promise<void> {
    this.fichaId = '';
    this.fichaRows = [];
    if (!this.fichaDeviceId) return;
    this.fichaLoading = true;
    const { rows, error } = await this.equipmentSheet.listFichas(this.fichaDeviceId);
    this.fichaLoading = false;
    if (error) {
      this.toast.error(`No se pudieron cargar fichas: ${error}`);
      return;
    }
    this.fichaRows = rows;
    if (rows.length === 1) this.fichaId = rows[0].id;
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
    if (tab === 'txv' || tab === 'sh' || tab === 'pt' || tab === 'camara') {
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
  }
}
