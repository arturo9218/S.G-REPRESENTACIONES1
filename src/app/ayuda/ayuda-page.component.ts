import { Component } from '@angular/core';
import { INICIO_DEVICE_MANUALS, type InicioDeviceManual } from '../inicio/inicio-device-manual';
import { downloadInicioManualPdf } from '../inicio/inicio-manual-pdf';

@Component({
  selector: 'app-ayuda-page',
  templateUrl: './ayuda-page.component.html',
  styleUrls: ['./ayuda-page.component.scss'],
})
export class AyudaPageComponent {
  readonly deviceManuals: InicioDeviceManual[] = INICIO_DEVICE_MANUALS;
  manualPdfBusy = false;

  async downloadManualPdf(manual: InicioDeviceManual): Promise<void> {
    if (this.manualPdfBusy) return;
    this.manualPdfBusy = true;
    try {
      await downloadInicioManualPdf(manual);
    } catch (err) {
      console.error('Error al generar PDF del manual', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`No se pudo generar el PDF: ${msg}`);
    } finally {
      this.manualPdfBusy = false;
    }
  }
}
