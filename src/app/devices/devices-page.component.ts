import { Component, ViewEncapsulation, inject } from '@angular/core';
import { DashboardComponent } from '../dashboard/dashboard.component';

/**
 * Vista Dispositivos: tarjetas, gráfico y secciones PRO400/PRO300/PR500.
 * La lógica vive en DashboardComponent; este componente aísla el template.
 */
@Component({
  selector: 'app-devices-page',
  templateUrl: './devices-page.component.html',
  styleUrls: ['./devices-page.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class DevicesPageComponent {
  readonly h = inject(DashboardComponent, { skipSelf: true });
}
