import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';

const BUCKET = 'equipment-photos';

export interface DeviceEquipmentFichaRow {
  id: string;
  deviceId: string;
  sortOrder: number;
  label: string;
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
  evaporatorAirType: string | null;
  evaporatorFanCount: number | null;
  evaporatorFanMotorPhases: string | null;
  evaporatorFanSinglePhaseDetail: string | null;
  evaporatorNotes: string | null;
  supply: string | null;
  pumpDown: boolean;
  defrost: string | null;
  chamberType: string | null;
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

export type EquipmentFichaPayload = Omit<
  DeviceEquipmentFichaRow,
  'deviceId' | 'updatedAt'
> & { deviceId: string };

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
      evaporatorAirType: (r['evaporator_air_type'] as string) ?? null,
      evaporatorFanCount:
        typeof r['evaporator_fan_count'] === 'number' ? (r['evaporator_fan_count'] as number) : null,
      evaporatorFanMotorPhases: (r['evaporator_fan_motor_phases'] as string) ?? null,
      evaporatorFanSinglePhaseDetail: (r['evaporator_fan_single_phase_detail'] as string) ?? null,
      evaporatorNotes: (r['evaporator_notes'] as string) ?? null,
      supply: (r['supply'] as string) ?? null,
      pumpDown: Boolean(r['pump_down']),
      defrost: (r['defrost'] as string) ?? null,
      chamberType: (r['chamber_type'] as string) ?? null,
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
    deviceId: string
  ): Promise<{ rows: DeviceEquipmentFichaRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_fichas')
      .select('*')
      .eq('device_id', deviceId)
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true });
    if (error) {
      return { rows: [], error: error.message };
    }
    return { rows: (data ?? []).map((r) => this.mapFicha(r as Record<string, unknown>)), error: null };
  }

  async upsertFicha(payload: EquipmentFichaPayload): Promise<{ error: string | null }> {
    const now = new Date().toISOString();
    const row = {
      id: payload.id,
      device_id: payload.deviceId,
      sort_order: payload.sortOrder,
      label: payload.label.trim() || 'Sin nombre',
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
      evaporator_air_type: payload.evaporatorAirType || null,
      evaporator_fan_count: payload.evaporatorFanCount,
      evaporator_fan_motor_phases: payload.evaporatorFanMotorPhases || null,
      evaporator_fan_single_phase_detail: payload.evaporatorFanSinglePhaseDetail || null,
      evaporator_notes: payload.evaporatorNotes || null,
      supply: payload.supply || null,
      pump_down: payload.pumpDown,
      defrost: payload.defrost || null,
      chamber_type: payload.chamberType || null,
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
    deviceId: string,
    label: string
  ): Promise<{ id: string | null; error: string | null }> {
    const { data: maxRows } = await this.auth.client
      .from('device_equipment_fichas')
      .select('sort_order')
      .eq('device_id', deviceId)
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
        device_id: deviceId,
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
    deviceId: string,
    fichaId: string
  ): Promise<{ rows: DeviceEquipmentLogRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_log')
      .select('*')
      .eq('device_id', deviceId)
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
    deviceId: string,
    fichaId: string,
    occurredAtIso: string,
    note: string
  ): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('device_equipment_log').insert({
      device_id: deviceId,
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
    deviceId: string,
    fichaId: string
  ): Promise<{ rows: DeviceEquipmentPhotoRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_photos')
      .select('*')
      .eq('device_id', deviceId)
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

  async uploadPhoto(
    deviceId: string,
    fichaId: string,
    file: File,
    caption: string | null
  ): Promise<{ error: string | null }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
    const name = `${crypto.randomUUID()}.${safeExt}`;
    const path = `${deviceId}/${fichaId}/${name}`;
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
      .eq('device_id', deviceId)
      .eq('ficha_id', fichaId)
      .order('sort_order', { ascending: false })
      .limit(1);
    const maxSo =
      maxRows?.length && typeof maxRows[0]['sort_order'] === 'number'
        ? (maxRows[0]['sort_order'] as number)
        : 0;
    const sortOrder = maxSo + 1;
    const { error: insErr } = await this.auth.client.from('device_equipment_photos').insert({
      device_id: deviceId,
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
