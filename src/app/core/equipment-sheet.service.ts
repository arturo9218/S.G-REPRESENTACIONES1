import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import type { EquipmentFichaKind, EquipmentFichaRef } from './equipment-ficha-target';

const BUCKET = 'equipment-photos';
const BRANDING_BUCKET = 'branding-logos';

export interface DeviceEquipmentFichaRow {
  id: string;
  deviceId: string;
  sortOrder: number;
  label: string;
  status: string | null;
  compressorText: string | null;
  hp: number | null;
  refrigerant: string | null;
  condenserCoolingType: string | null;
  condenserFanCount: number | null;
  condenserBladeDiameterText: string | null;
  condenserFanMotorPhases: string | null;
  condenserFanCapacitorUf: string | null;
  condenserNotes: string | null;
  /** capillary | valve */
  expansionType: string | null;
  expansionCapillaryMeasure: string | null;
  expansionValveBrand: string | null;
  expansionValveModel: string | null;
  expansionOrificeText: string | null;
  expansionFilterMeasureText: string | null;
  expansionReceiverTubeText: string | null;
  expansionSolenoidValveText: string | null;
  evaporatorAirType: string | null;
  evaporatorFanCount: number | null;
  evaporatorFanMotorPhases: string | null;
  evaporatorFanSinglePhaseDetail: string | null;
  /** Diámetro de pala u observación de forzadores del evaporador. */
  evaporatorFanBladeDiameterText: string | null;
  evaporatorNotes: string | null;
  supply: string | null;
  pumpDown: boolean;
  defrost: string | null;
  chamberType: string | null;
  suctionLineDiameter: string | null;
  liquidLineDiameter: string | null;
  lineInsulationStatus: string | null;
  highPressureSwitch: string | null;
  lowPressureSwitch: string | null;
  controllerModel: string | null;
  contactorStatus: string | null;
  suctionPressureBar: number | null;
  dischargePressureBar: number | null;
  superheatC: number | null;
  subcoolingC: number | null;
  compressorCurrentA: number | null;
  freeNotes: string | null;
  lastMaintenanceAt: string | null;
  nextMaintenanceAt: string | null;
  maintenanceIntervalDays: number | null;
  maintenanceNotifyEnabled: boolean;
  updatedAt: string | null;
}

export interface DeviceEquipmentLogRow {
  id: string;
  deviceId: string;
  fichaId: string | null;
  occurredAt: string;
  note: string;
  createdAt: string;
}

export interface DeviceEquipmentPhotoRow {
  id: string;
  deviceId: string;
  fichaId: string | null;
  storagePath: string;
  sortOrder: number;
  caption: string | null;
  createdAt: string;
  publicUrl: string;
}

export interface UserBrandingRow {
  userId: string;
  companyName: string | null;
  logoStoragePath: string | null;
  updatedAt: string | null;
  logoPublicUrl: string | null;
}

export type EquipmentFichaPayload = Omit<
  DeviceEquipmentFichaRow,
  'deviceId' | 'updatedAt'
> & { deviceId: string; equipmentKind?: EquipmentFichaKind };

@Injectable({
  providedIn: 'root',
})
export class EquipmentSheetService {
  constructor(private readonly auth: AuthService) {}

  private mapFicha(r: Record<string, unknown>): DeviceEquipmentFichaRow {
    return {
      id: r['id'] as string,
      deviceId: r['device_id'] as string,
      sortOrder: typeof r['sort_order'] === 'number' ? (r['sort_order'] as number) : 0,
      label: (r['label'] as string) || 'Instalación',
      status: (r['status'] as string) ?? 'draft',
      compressorText: (r['compressor_text'] as string) ?? null,
      hp: typeof r['hp'] === 'number' ? (r['hp'] as number) : null,
      refrigerant: (r['refrigerant'] as string) ?? null,
      condenserCoolingType: (r['condenser_cooling_type'] as string) ?? null,
      condenserFanCount:
        typeof r['condenser_fan_count'] === 'number' ? (r['condenser_fan_count'] as number) : null,
      condenserBladeDiameterText: (r['condenser_blade_diameter_text'] as string) ?? null,
      condenserFanMotorPhases: (r['condenser_fan_motor_phases'] as string) ?? null,
      condenserFanCapacitorUf: (r['condenser_fan_capacitor_uf'] as string) ?? null,
      condenserNotes: (r['condenser_notes'] as string) ?? null,
      expansionType: (r['expansion_type'] as string) ?? null,
      expansionCapillaryMeasure: (r['expansion_capillary_measure'] as string) ?? null,
      expansionValveBrand: (r['expansion_valve_brand'] as string) ?? null,
      expansionValveModel: (r['expansion_valve_model'] as string) ?? null,
      expansionOrificeText: (r['expansion_orifice_text'] as string) ?? null,
      expansionFilterMeasureText: (r['expansion_filter_measure_text'] as string) ?? null,
      expansionReceiverTubeText: (r['expansion_receiver_tube_text'] as string) ?? null,
      expansionSolenoidValveText: (r['expansion_solenoid_valve_text'] as string) ?? null,
      evaporatorAirType: (r['evaporator_air_type'] as string) ?? null,
      evaporatorFanCount:
        typeof r['evaporator_fan_count'] === 'number' ? (r['evaporator_fan_count'] as number) : null,
      evaporatorFanMotorPhases: (r['evaporator_fan_motor_phases'] as string) ?? null,
      evaporatorFanSinglePhaseDetail: (r['evaporator_fan_single_phase_detail'] as string) ?? null,
      evaporatorFanBladeDiameterText: (r['evaporator_fan_blade_diameter_text'] as string) ?? null,
      evaporatorNotes: (r['evaporator_notes'] as string) ?? null,
      supply: (r['supply'] as string) ?? null,
      pumpDown: Boolean(r['pump_down']),
      defrost: (r['defrost'] as string) ?? null,
      chamberType: (r['chamber_type'] as string) ?? null,
      suctionLineDiameter: (r['suction_line_diameter'] as string) ?? null,
      liquidLineDiameter: (r['liquid_line_diameter'] as string) ?? null,
      lineInsulationStatus: (r['line_insulation_status'] as string) ?? null,
      highPressureSwitch: (r['high_pressure_switch'] as string) ?? null,
      lowPressureSwitch: (r['low_pressure_switch'] as string) ?? null,
      controllerModel: (r['controller_model'] as string) ?? null,
      contactorStatus: (r['contactor_status'] as string) ?? null,
      suctionPressureBar:
        typeof r['suction_pressure_bar'] === 'number' ? (r['suction_pressure_bar'] as number) : null,
      dischargePressureBar:
        typeof r['discharge_pressure_bar'] === 'number'
          ? (r['discharge_pressure_bar'] as number)
          : null,
      superheatC: typeof r['superheat_c'] === 'number' ? (r['superheat_c'] as number) : null,
      subcoolingC: typeof r['subcooling_c'] === 'number' ? (r['subcooling_c'] as number) : null,
      compressorCurrentA:
        typeof r['compressor_current_a'] === 'number' ? (r['compressor_current_a'] as number) : null,
      freeNotes: (r['free_notes'] as string) ?? null,
      lastMaintenanceAt: (r['last_maintenance_at'] as string) ?? null,
      nextMaintenanceAt: (r['next_maintenance_at'] as string) ?? null,
      maintenanceIntervalDays:
        typeof r['maintenance_interval_days'] === 'number'
          ? (r['maintenance_interval_days'] as number)
          : null,
      maintenanceNotifyEnabled: r['maintenance_notify_enabled'] !== false,
      updatedAt: (r['updated_at'] as string) ?? null,
    };
  }

  async listFichas(
    ref: EquipmentFichaRef
  ): Promise<{ rows: DeviceEquipmentFichaRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_fichas')
      .select('*')
      .eq('device_id', ref.entityId)
      .eq('equipment_kind', ref.kind)
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true });
    if (error) {
      return { rows: [], error: error.message };
    }
    return { rows: (data ?? []).map((r) => this.mapFicha(r as Record<string, unknown>)), error: null };
  }

  async upsertFicha(payload: EquipmentFichaPayload): Promise<{ error: string | null }> {
    const now = new Date().toISOString();
    const kind = payload.equipmentKind ?? 'device';
    const row = {
      id: payload.id,
      device_id: payload.deviceId,
      equipment_kind: kind,
      sort_order: payload.sortOrder,
      label: payload.label.trim() || 'Sin nombre',
      status: payload.status || 'draft',
      compressor_text: payload.compressorText || null,
      hp: payload.hp,
      refrigerant: payload.refrigerant || null,
      condenser_cooling_type: payload.condenserCoolingType || null,
      condenser_fan_count: payload.condenserFanCount,
      condenser_blade_diameter_text: payload.condenserBladeDiameterText || null,
      condenser_fan_motor_phases: payload.condenserFanMotorPhases || null,
      condenser_fan_capacitor_uf: payload.condenserFanCapacitorUf || null,
      condenser_notes: payload.condenserNotes || null,
      expansion_type: payload.expansionType || null,
      expansion_capillary_measure: payload.expansionCapillaryMeasure || null,
      expansion_valve_brand: payload.expansionValveBrand || null,
      expansion_valve_model: payload.expansionValveModel || null,
      expansion_orifice_text: payload.expansionOrificeText || null,
      expansion_filter_measure_text: payload.expansionFilterMeasureText || null,
      expansion_receiver_tube_text: payload.expansionReceiverTubeText || null,
      expansion_solenoid_valve_text: payload.expansionSolenoidValveText || null,
      evaporator_air_type: payload.evaporatorAirType || null,
      evaporator_fan_count: payload.evaporatorFanCount,
      evaporator_fan_motor_phases: payload.evaporatorFanMotorPhases || null,
      evaporator_fan_single_phase_detail: payload.evaporatorFanSinglePhaseDetail || null,
      evaporator_fan_blade_diameter_text: payload.evaporatorFanBladeDiameterText || null,
      evaporator_notes: payload.evaporatorNotes || null,
      supply: payload.supply || null,
      pump_down: payload.pumpDown,
      defrost: payload.defrost || null,
      chamber_type: payload.chamberType || null,
      suction_line_diameter: payload.suctionLineDiameter || null,
      liquid_line_diameter: payload.liquidLineDiameter || null,
      line_insulation_status: payload.lineInsulationStatus || null,
      high_pressure_switch: payload.highPressureSwitch || null,
      low_pressure_switch: payload.lowPressureSwitch || null,
      controller_model: payload.controllerModel || null,
      contactor_status: payload.contactorStatus || null,
      suction_pressure_bar: payload.suctionPressureBar,
      discharge_pressure_bar: payload.dischargePressureBar,
      superheat_c: payload.superheatC,
      subcooling_c: payload.subcoolingC,
      compressor_current_a: payload.compressorCurrentA,
      free_notes: payload.freeNotes || null,
      last_maintenance_at: payload.lastMaintenanceAt || null,
      next_maintenance_at: payload.nextMaintenanceAt || null,
      maintenance_interval_days: payload.maintenanceIntervalDays,
      maintenance_notify_enabled: payload.maintenanceNotifyEnabled,
      updated_at: now,
    };
    const { error } = await this.auth.client.from('device_equipment_fichas').upsert(row, {
      onConflict: 'id',
    });
    return { error: error?.message ?? null };
  }

  async createFicha(
    ref: EquipmentFichaRef,
    label: string
  ): Promise<{ id: string | null; error: string | null }> {
    const { data: maxRows } = await this.auth.client
      .from('device_equipment_fichas')
      .select('sort_order')
      .eq('device_id', ref.entityId)
      .eq('equipment_kind', ref.kind)
      .order('sort_order', { ascending: false })
      .limit(1);
    const maxSo =
      maxRows?.length && typeof maxRows[0]['sort_order'] === 'number'
        ? (maxRows[0]['sort_order'] as number)
        : -1;
    const sortOrder = maxSo + 1;
    const { data, error } = await this.auth.client
      .from('device_equipment_fichas')
      .insert({
        device_id: ref.entityId,
        equipment_kind: ref.kind,
        sort_order: sortOrder,
        label: label.trim() || `Cámara ${sortOrder + 1}`,
        maintenance_notify_enabled: true,
      })
      .select('id')
      .single();
    if (error || !data) {
      return { id: null, error: error?.message ?? 'No se pudo crear la ficha' };
    }
    return { id: data['id'] as string, error: null };
  }

  async deleteFicha(fichaId: string): Promise<{ error: string | null }> {
    const { data: photos, error: pe } = await this.auth.client
      .from('device_equipment_photos')
      .select('storage_path')
      .eq('ficha_id', fichaId);
    if (pe) {
      return { error: pe.message };
    }
    const paths = (photos ?? []).map((p) => p['storage_path'] as string);
    if (paths.length) {
      await this.auth.client.storage.from(BUCKET).remove(paths);
    }
    await this.auth.client.from('device_equipment_photos').delete().eq('ficha_id', fichaId);
    await this.auth.client.from('device_equipment_log').delete().eq('ficha_id', fichaId);
    const { error } = await this.auth.client.from('device_equipment_fichas').delete().eq('id', fichaId);
    return { error: error?.message ?? null };
  }

  async listLog(
    ref: EquipmentFichaRef,
    fichaId: string
  ): Promise<{ rows: DeviceEquipmentLogRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_log')
      .select('*')
      .eq('device_id', ref.entityId)
      .eq('equipment_kind', ref.kind)
      .eq('ficha_id', fichaId)
      .order('occurred_at', { ascending: false });
    if (error) {
      return { rows: [], error: error.message };
    }
    const rows = (data ?? []).map((r) => this.mapLog(r as Record<string, unknown>));
    return { rows, error: null };
  }

  private mapLog(r: Record<string, unknown>): DeviceEquipmentLogRow {
    return {
      id: r['id'] as string,
      deviceId: r['device_id'] as string,
      fichaId: (r['ficha_id'] as string) ?? null,
      occurredAt: r['occurred_at'] as string,
      note: r['note'] as string,
      createdAt: r['created_at'] as string,
    };
  }

  async insertLog(
    ref: EquipmentFichaRef,
    fichaId: string,
    occurredAtIso: string,
    note: string
  ): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('device_equipment_log').insert({
      device_id: ref.entityId,
      equipment_kind: ref.kind,
      ficha_id: fichaId,
      occurred_at: occurredAtIso,
      note: note.trim(),
    });
    return { error: error?.message ?? null };
  }

  async deleteLog(id: string): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('device_equipment_log').delete().eq('id', id);
    return { error: error?.message ?? null };
  }

  async listPhotos(
    ref: EquipmentFichaRef,
    fichaId: string
  ): Promise<{ rows: DeviceEquipmentPhotoRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_photos')
      .select('*')
      .eq('device_id', ref.entityId)
      .eq('equipment_kind', ref.kind)
      .eq('ficha_id', fichaId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      return { rows: [], error: error.message };
    }
    const rows = (data ?? []).map((r) => this.mapPhoto(r as Record<string, unknown>));
    return { rows, error: null };
  }

  private mapPhoto(r: Record<string, unknown>): DeviceEquipmentPhotoRow {
    const path = r['storage_path'] as string;
    const { data: pub } = this.auth.client.storage.from(BUCKET).getPublicUrl(path);
    return {
      id: r['id'] as string,
      deviceId: r['device_id'] as string,
      fichaId: (r['ficha_id'] as string) ?? null,
      storagePath: path,
      sortOrder: typeof r['sort_order'] === 'number' ? (r['sort_order'] as number) : 0,
      caption: (r['caption'] as string) ?? null,
      createdAt: r['created_at'] as string,
      publicUrl: pub.publicUrl,
    };
  }

  private mapBranding(r: Record<string, unknown>): UserBrandingRow {
    const logoStoragePath = (r['logo_storage_path'] as string) ?? null;
    const logoPublicUrl = logoStoragePath
      ? this.auth.client.storage.from(BRANDING_BUCKET).getPublicUrl(logoStoragePath).data.publicUrl
      : null;
    return {
      userId: r['user_id'] as string,
      companyName: (r['company_name'] as string) ?? null,
      logoStoragePath,
      updatedAt: (r['updated_at'] as string) ?? null,
      logoPublicUrl,
    };
  }

  async getUserBranding(): Promise<{ row: UserBrandingRow | null; error: string | null }> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) {
      return { row: null, error: 'Sesión no disponible.' };
    }
    const { data, error } = await this.auth.client
      .from('user_branding')
      .select('*')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) {
      return { row: null, error: error.message };
    }
    if (!data) {
      return { row: null, error: null };
    }
    return { row: this.mapBranding(data as Record<string, unknown>), error: null };
  }

  async upsertUserBranding(payload: {
    companyName: string | null;
    logoStoragePath: string | null;
  }): Promise<{ error: string | null }> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) {
      return { error: 'Sesión no disponible.' };
    }
    const { error } = await this.auth.client.from('user_branding').upsert(
      {
        user_id: uid,
        company_name: payload.companyName?.trim() || null,
        logo_storage_path: payload.logoStoragePath,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    return { error: error?.message ?? null };
  }

  async uploadBrandingLogo(file: File): Promise<{ storagePath: string | null; error: string | null }> {
    const session = await this.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) {
      return { storagePath: null, error: 'Sesión no disponible.' };
    }
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'png';
    const name = `logo_${Date.now()}_${crypto.randomUUID()}.${safeExt}`;
    const path = `${uid}/${name}`;
    const { error } = await this.auth.client.storage.from(BRANDING_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
    });
    if (error) {
      return { storagePath: null, error: error.message };
    }
    return { storagePath: path, error: null };
  }

  async deleteBrandingLogo(storagePath: string): Promise<void> {
    if (!storagePath) return;
    await this.auth.client.storage.from(BRANDING_BUCKET).remove([storagePath]);
  }

  async uploadPhoto(
    ref: EquipmentFichaRef,
    fichaId: string,
    file: File,
    caption: string | null
  ): Promise<{ error: string | null }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
    const name = `${crypto.randomUUID()}.${safeExt}`;
    const path = `${ref.entityId}/${fichaId}/${name}`;
    const { error: upErr } = await this.auth.client.storage.from(BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
    });
    if (upErr) {
      return { error: upErr.message };
    }
    const { data: maxRows } = await this.auth.client
      .from('device_equipment_photos')
      .select('sort_order')
      .eq('device_id', ref.entityId)
      .eq('equipment_kind', ref.kind)
      .eq('ficha_id', fichaId)
      .order('sort_order', { ascending: false })
      .limit(1);
    const maxSo =
      maxRows?.length && typeof maxRows[0]['sort_order'] === 'number'
        ? (maxRows[0]['sort_order'] as number)
        : 0;
    const sortOrder = maxSo + 1;
    const { error: insErr } = await this.auth.client.from('device_equipment_photos').insert({
      device_id: ref.entityId,
      equipment_kind: ref.kind,
      ficha_id: fichaId,
      storage_path: path,
      sort_order: sortOrder,
      caption: caption?.trim() || null,
    });
    if (insErr) {
      void this.auth.client.storage.from(BUCKET).remove([path]);
      return { error: insErr.message };
    }
    return { error: null };
  }

  async deletePhoto(photo: DeviceEquipmentPhotoRow): Promise<{ error: string | null }> {
    const { error: stErr } = await this.auth.client.storage.from(BUCKET).remove([photo.storagePath]);
    if (stErr) {
      console.warn('storage remove:', stErr.message);
    }
    const { error } = await this.auth.client.from('device_equipment_photos').delete().eq('id', photo.id);
    return { error: error?.message ?? null };
  }

  getPublicUrlForPath(storagePath: string): string {
    const { data } = this.auth.client.storage.from(BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
  }
}
