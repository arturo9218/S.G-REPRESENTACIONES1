import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { DashboardAlert } from '../core/models/dashboard.models';

export type InicioEquipmentKind = 'pr500' | 'pro400' | 'pro300' | 'datalogger';

export interface InicioGalleryItem {
  title: string;
  caption: string;
  image: string;
}

export interface InicioFleetRow {
  /** Clave única para la lista (puede llevar prefijo d-/p-/c-). */
  id: string;
  /** ID real del equipo en la base (UUID). */
  entityId: string;
  kind: 'sensor' | 'pr500' | 'combistato' | 'pro400' | 'datalogger';
  name: string;
  detail: string;
  online: boolean;
  hasAlert: boolean;
}

@Component({
  selector: 'app-inicio-page',
  templateUrl: './inicio-page.component.html',
  styleUrls: ['./inicio-page.component.scss'],
})
export class InicioPageComponent {
  @Input() userEmail: string | null = null;
  @Input() userInitial = '?';
  @Input() deviceCount = 0;
  @Input() combistatoCount = 0;
  @Input() pro400Count = 0;
  @Input() pr500Count = 0;
  @Input() dataloggerCount = 0;
  @Input() activeAlerts = 0;
  @Input() accumulatedAlerts = 0;
  @Input() cloudSyncActive = false;
  @Input() lastDataLabel = '';
  @Input() attentionAlerts: DashboardAlert[] = [];
  @Input() fleetRows: InicioFleetRow[] = [];
  @Input() fleetSearchQuery = '';

  @Output() goDevices = new EventEmitter<void>();
  @Output() goAlerts = new EventEmitter<void>();
  @Output() goAyuda = new EventEmitter<void>();
  @Output() goHerramientas = new EventEmitter<void>();
  @Output() goComunidad = new EventEmitter<void>();
  @Output() goPresupuestos = new EventEmitter<void>();
  @Output() addEquipment = new EventEmitter<InicioEquipmentKind>();
  /** Clic en una fila de «Tus equipos»: ir a Dispositivos y mostrar esa tarjeta. */
  @Output() openFleetRow = new EventEmitter<InicioFleetRow>();

  readonly equipmentOptions: {
    kind: InicioEquipmentKind;
    title: string;
    desc: string;
    badge: string;
  }[] = [
    {
      kind: 'pr500',
      title: 'PR500',
      desc: 'Central frigorífica: presión, compresores y recalentamiento.',
      badge: 'Presión',
    },
    {
      kind: 'pro400',
      title: 'PRO400',
      desc: 'Controlador 1 sonda: parámetros AR01–AR26 y alarmas por temperatura.',
      badge: 'AR01–AR26',
    },
    {
      kind: 'pro300',
      title: 'PRO300',
      desc: 'Controlador de cámara: 2 sondas, compresor / ventilador / deshielo y parámetros AR01–AR48.',
      badge: '2 sondas + control',
    },
    {
      kind: 'datalogger',
      title: 'Datalogger',
      desc: '6 temperaturas, 3 consumos y 2 presiones. Parámetros AR12–AR48 y gráfico histórico.',
      badge: 'Multi-canal',
    },
  ];

  fleetKindLabel(kind: InicioFleetRow['kind']): string {
    switch (kind) {
      case 'pr500':
        return 'PR500';
      case 'combistato':
        return 'PRO300';
      case 'pro400':
        return 'PRO400';
      case 'datalogger':
        return 'Datalogger';
      default:
        return 'Panel';
    }
  }

  fleetKindClass(kind: InicioFleetRow['kind']): string {
    return `inicio-fleet__kind--${kind}`;
  }

  readonly gallery: InicioGalleryItem[] = [
    {
      title: 'Cámara de frío',
      caption: 'Monitoreo de temperatura, alarmas e historial en plantas de frío industrial.',
      image: 'assets/inicio/camara-frio.svg',
    },
    {
      title: 'Sala de máquinas',
      caption: 'Controladores PR500: presión, compresores ON/OFF y recalentamiento en un solo panel.',
      image: 'assets/inicio/compresores.svg',
    },
    {
      title: 'Vitrinas y comercio',
      caption: 'Sondas y paneles para mantener la cadena de frío en exhibición.',
      image: 'assets/inicio/vitrina.svg',
    },
  ];

  get totalEquipos(): number {
    return this.deviceCount + this.pro400Count + this.combistatoCount + this.pr500Count + this.dataloggerCount;
  }

  get attentionTop(): DashboardAlert[] {
    return this.attentionAlerts.slice(0, 8);
  }

  get fleetTop(): InicioFleetRow[] {
    return this.fleetRows.slice(0, 10);
  }

  get fleetSearchActive(): boolean {
    return this.fleetSearchQuery.trim().length > 0;
  }

  get greeting(): string {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  }

  pickEquipment(kind: InicioEquipmentKind): void {
    this.addEquipment.emit(kind);
  }
}
