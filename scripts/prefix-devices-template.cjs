/**
 * Prefija referencias del dashboard en el template de devices-page con h.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/app/devices/_chunk.html'), 'utf8');

const members = [
  'environment', 'deviceStore', 'combistatoStore', 'hasAnyEquipment', 'lastDataRefreshStale',
  'lastDataRefreshLabel', 'lastDataRefreshAgeLabel', 'readingsPollIntervalSec', 'isDeviceSoloView',
  'deviceSoloFocusLabel', 'clearDeviceSoloView', 'showDevicesChartInView', 'chartExpanded',
  'chartStylePreset', 'selectedDevice', 'toggleChartExpanded', 'selectedDeviceId', 'devices',
  'openChartInNewTab', 'chartStyleOptions', 'onChartStyleChange', 'selectedSensor1Name', 'selectedSensor2Name',
  'chartHasSecondSeries', 'chartHasCurrentSeries', 'chartYMaxLabel', 'chartYMidLabel', 'chartYMinLabel',
  'chartGridYStops', 'chartGridXStops', 'chartPointsS1', 'chartPointsS2', 'chartPointsCurrent',
  'chartCurrentYMaxLabel', 'chartCurrentYMinLabel', 'chartCurrentGridYStops', 'chartTimelineItems',
  'chartTempRangeLabel', 'chartCurrentRangeLabel', 'chartCurrentLatestLabel', 'avgDeltaLabel',
  'chartDayLabels', 'filteredDevices', 'devicesForView', 'selectDevice', 'trackByDeviceId',
  'formatTempCard', 'formatTempCardValueOnly', 'formatCurrent', 'formatPower', 'selectedTelemetry',
  'selectedTelemetryCurrentA', 'hasDualTelemetry', 'goToEquipmentSheet', 'openEditDeviceModal',
  'confirmDeleteDevice', 'showPro400SectionInView', 'pro400sForView', 'trackByPro400Id', 'selectPro400',
  'openAddPro400Modal', 'pro400PhaseHasTimer', 'combistatoPhaseLabel', 'formatMinSec',
  'pro400PhaseRemainingS', 'openPro400Settings', 'goPro400Settings', 'openEditPro400Modal',
  'confirmDeletePro400', 'showCombistatoSectionInView', 'combistatosForView', 'combistatos',
  'trackByCombistatoId', 'selectCombistato', 'openAddCombistatoModal', 'combistatoRelayPillClass',
  'openCombistatoSettings', 'goCombistatoSettings', 'combistatoPhaseHasTimer', 'combistatoPhaseRemainingS',
  'combistatoRelayTooltip', 'onCombistatoRelayClick', 'openEditCombistatoModal', 'confirmDeleteCombistato',
  'showPr500SectionInView', 'pr500sForView', 'trackByPr500Id', 'selectPr500', 'openAddPr500Modal',
  'pr500PressureLabel', 'pr500CompLabel', 'pr500PressureDisplayUnit', 'pr500PressureDisplayValue',
  'pr500CompressorLine', 'pr500RuntimeHoursLine', 'pr500TempSuperheatLine', 'openPr500Settings',
  'goPr500Settings', 'openEditPr500Modal', 'confirmDeletePr500', 'pr500s', 'showDevicePanelsInView',
  'openAddDeviceModal', 'scrollToSection', 'shellRoute', 'chartCurrentLabel', 'chartCurrentLabel2',
  'hasHumidity', 'humidityLabel', 'chartShowsAreaFill', 'chartPolylinePoints', 'chartPolylinePoints2',
  'chartTrendSegments1', 'chartTrendMarkers1', 'chartTrendSegments2', 'chartTrendMarkers2',
  'currentChartYMaxLabel', 'currentChartYMidLabel', 'currentChartYMinLabel', 'currentChartPolylinePoints',
  'deviceFirstSensorLabel', 'deviceFirstTempC', 'deviceShowClampRow', 'formatDeviceClampMain',
  'formatDeviceClampAmpNum', 'formatDeviceClampSub', 'isAdminView', 'formatOwnerUserIdShort',
  'deviceCanOpenEquipmentSheet', 'selectedPro400Id', 'selectedCombistatoId', 'selectedPr500Id',
];

let t = src;
t = t.replace(/\s*&&\s*\(shellRoute === 'devices'\)/g, '');
t = t.replace(/\(shellRoute === 'devices'\)\s*&&\s*/g, '');
t = t.replace(/\*ngIf="\s*&&/g, '*ngIf="');

const protectedChunks = [];
function protect(re) {
  t = t.replace(re, (m) => {
    const i = protectedChunks.length;
    protectedChunks.push(m);
    return `__P${i}__`;
  });
}
protect(/class="[^"]*"/g);
protect(/id="[^"]*"/g);
protect(/\[class\.[^\]]+\]/g);
protect(/#([a-zA-Z][\w-]*)/g);

t = t.replace(/\(click\)="([a-zA-Z_][\w]*)/g, (m, fn) =>
  fn === '$event' ? m : `(click)="h.${fn}`
);
t = t.replace(/\(keydown\.[a-z]+\)="([a-zA-Z_][\w]*)/g, (m, fn) => m.replace(`="${fn}`, `="h.${fn}`));
t = t.replace(/\(ngModelChange\)="([a-zA-Z_][\w]*)/g, '(ngModelChange)="h.$1');
t = t.replace(/\[\(ngModel\)\]="([a-zA-Z_][\w]*)/g, '[(ngModel)]="h.$1');
t = t.replace(/\[ngModel\]="([a-zA-Z_][\w]*)/g, '[ngModel]="h.$1');
t = t.replace(/\[disabled\]="([a-zA-Z_][\w]*)/g, '[disabled]="h.$1');

const sorted = [...members].sort((a, b) => b.length - a.length);
for (const m of sorted) {
  const re = new RegExp(`(?<!h\\.)\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  t = t.replace(re, `h.${m}`);
}
t = t.replace(/h\.h\./g, 'h.');

protectedChunks.forEach((chunk, i) => {
  t = t.replace(`__P${i}__`, () => chunk);
});

t = t.replace(/\uFEFF/g, '');

const out = `<div class="grid-main__left">\n${t}\n</div>\n`;
fs.writeFileSync(path.join(root, 'src/app/devices/devices-page.component.html'), out, 'utf8');
console.log('Wrote devices-page.component.html', out.length, 'chars');
