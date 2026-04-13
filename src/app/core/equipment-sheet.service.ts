import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';

const BUCKET = 'equipment-photos';

export interface DeviceEquipmentSheetRow {
  deviceId: string;
  compressorText: string | null;
  hp: number | null;
  refrigerant: string | null;
  condenserText: string | null;
  evaporatorText: string | null;
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
  occurredAt: string;
  note: string;
  createdAt: string;
}

export interface DeviceEquipmentPhotoRow {
  id: string;
  deviceId: string;
  storagePath: string;
  sortOrder: number;
  caption: string | null;
  createdAt: string;
  publicUrl: string;
}

export type EquipmentSheetPayload = Omit<
  DeviceEquipmentSheetRow,
  'deviceId' | 'updatedAt'
> & { deviceId: string };

@Injectable({
  providedIn: 'root',
})
export class EquipmentSheetService {
  constructor(private readonly auth: AuthService) {}

  private mapSheet(r: Record<string, unknown>): DeviceEquipmentSheetRow {
    return {
      deviceId: r['device_id'] as string,
      compressorText: (r['compressor_text'] as string) ?? null,
      hp: typeof r['hp'] === 'number' ? (r['hp'] as number) : null,
      refrigerant: (r['refrigerant'] as string) ?? null,
      condenserText: (r['condenser_text'] as string) ?? null,
      evaporatorText: (r['evaporator_text'] as string) ?? null,
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

  async fetchSheet(deviceId: string): Promise<{ row: DeviceEquipmentSheetRow | null; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_sheets')
      .select('*')
      .eq('device_id', deviceId)
      .maybeSingle();
    if (error) {
      return { row: null, error: error.message };
    }
    if (!data) {
      return { row: null, error: null };
    }
    return { row: this.mapSheet(data as Record<string, unknown>), error: null };
  }

  async upsertSheet(payload: EquipmentSheetPayload): Promise<{ error: string | null }> {
    const now = new Date().toISOString();
    const row = {
      device_id: payload.deviceId,
      compressor_text: payload.compressorText || null,
      hp: payload.hp,
      refrigerant: payload.refrigerant || null,
      condenser_text: payload.condenserText || null,
      evaporator_text: payload.evaporatorText || null,
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
    const { error } = await this.auth.client.from('device_equipment_sheets').upsert(row, {
      onConflict: 'device_id',
    });
    return { error: error?.message ?? null };
  }

  async listLog(deviceId: string): Promise<{ rows: DeviceEquipmentLogRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_log')
      .select('*')
      .eq('device_id', deviceId)
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
      occurredAt: r['occurred_at'] as string,
      note: r['note'] as string,
      createdAt: r['created_at'] as string,
    };
  }

  async insertLog(deviceId: string, occurredAtIso: string, note: string): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('device_equipment_log').insert({
      device_id: deviceId,
      occurred_at: occurredAtIso,
      note: note.trim(),
    });
    return { error: error?.message ?? null };
  }

  async deleteLog(id: string): Promise<{ error: string | null }> {
    const { error } = await this.auth.client.from('device_equipment_log').delete().eq('id', id);
    return { error: error?.message ?? null };
  }

  async listPhotos(deviceId: string): Promise<{ rows: DeviceEquipmentPhotoRow[]; error: string | null }> {
    const { data, error } = await this.auth.client
      .from('device_equipment_photos')
      .select('*')
      .eq('device_id', deviceId)
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
      storagePath: path,
      sortOrder: typeof r['sort_order'] === 'number' ? (r['sort_order'] as number) : 0,
      caption: (r['caption'] as string) ?? null,
      createdAt: r['created_at'] as string,
      publicUrl: pub.publicUrl,
    };
  }

  async uploadPhoto(
    deviceId: string,
    file: File,
    caption: string | null
  ): Promise<{ error: string | null }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
    const name = `${crypto.randomUUID()}.${safeExt}`;
    const path = `${deviceId}/${name}`;
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
      .order('sort_order', { ascending: false })
      .limit(1);
    const maxSo =
      maxRows?.length && typeof maxRows[0]['sort_order'] === 'number'
        ? (maxRows[0]['sort_order'] as number)
        : 0;
    const sortOrder = maxSo + 1;
    const { error: insErr } = await this.auth.client.from('device_equipment_photos').insert({
      device_id: deviceId,
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
