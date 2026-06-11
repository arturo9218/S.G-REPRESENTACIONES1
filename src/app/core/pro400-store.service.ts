import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { DashboardDevice, DashboardPro400 } from './models/dashboard.models';
import { DeviceStoreService } from './device-store.service';
import { ingestFunctionUrl } from './supabase-config';

export type AddPro400Result =
  | {
      ok: true;
      id: string;
      credentials: { moduleId: string; deviceToken: string; ingestUrl: string };
    }
  | { ok: false; error: string };

function mapDeviceToPro400(d: DashboardDevice): DashboardPro400 {
  return {
    id: d.id,
    name: d.name,
    location: d.location,
    moduleId: d.moduleId,
    updatedAtLabel: d.updatedAtLabel,
    lastSeenLabel: d.updatedAtLabel,
    online: d.online,
    ownerUserId: d.ownerUserId,
    deviceToken: d.deviceToken,
    lastTemp1C: d.temperatureC ?? null,
    lastCompOn: d.lastCompOn,
    lastDefrostOn: d.lastDefrostOn,
    lastPhase: d.lastPhase,
    lastPhaseElapsedS: d.lastPhaseElapsedS,
    lastPhaseTotalS: d.lastPhaseTotalS,
  };
}

@Injectable({
  providedIn: 'root',
})
export class Pro400StoreService {
  private readonly subject = new BehaviorSubject<DashboardPro400[]>([]);
  readonly pro400s$ = this.subject.asObservable();

  constructor(private readonly deviceStore: DeviceStoreService) {
    this.deviceStore.devices$.subscribe((list) => {
      this.subject.next(list.filter((d) => d.equipmentKind === 'pro400').map(mapDeviceToPro400));
    });
  }

  get snapshot(): DashboardPro400[] {
    return this.subject.value;
  }

  getIngestUrl(): string {
    return ingestFunctionUrl();
  }

  async addPro400FromFormAsync(input: {
    name: string;
    location: string;
    moduleId: string;
  }): Promise<AddPro400Result> {
    const result = await this.deviceStore.addDeviceFromFormAsync({
      name: input.name,
      location: input.location,
      moduleId: input.moduleId,
      espLocalIp: '',
      equipmentKind: 'pro400',
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    await this.deviceStore.updateDeviceSensorLabels(result.id, 'Sonda', '—');
    await this.deviceStore.updateDeviceNotificationConfig(result.id, {
      alertsEnabled: true,
      tempLowC: 2,
      tempHighC: 8,
      temp2LowC: null,
      temp2HighC: null,
      currentMaxA: null,
      nominalVoltageV: 220,
      tempPushCooldownMs: 15 * 60 * 1000,
      offlinePushCooldownMs: 15 * 60 * 1000,
    });
    if (!result.credentials) {
      return { ok: false, error: 'No se generaron credenciales de conexión.' };
    }
    return { ok: true, id: result.id, credentials: result.credentials };
  }

  async updatePro400Meta(
    id: string,
    input: { name: string; location: string; moduleId: string }
  ): Promise<{ ok: boolean; error?: string }> {
    return this.deviceStore.updateDeviceMeta(id, { ...input, espLocalIp: '' });
  }

  async removePro400Async(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.deviceStore.removeDeviceAsync(id);
  }
}
