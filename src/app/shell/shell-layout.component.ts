import { Component, EventEmitter, Input, Output } from '@angular/core';
import { shellMoreActive, type ShellRoute } from './shell-route.model';

@Component({
  selector: 'app-shell-layout',
  templateUrl: './shell-layout.component.html',
  styleUrls: ['./shell-layout.component.scss'],
})
export class ShellLayoutComponent {
  @Input({ required: true }) shellRoute!: ShellRoute;
  @Input() hasShellContent = true;
  @Input() hasAnyEquipment = false;
  @Input() isAdminView = false;
  @Input() email: string | null = null;
  @Input() userInitial = '?';
  @Input() searchQuery = '';
  @Output() searchQueryChange = new EventEmitter<string>();
  @Input() summaryAlarmEvents = 0;
  @Input() chatUnreadTotal = 0;
  @Input() mobileNavMoreOpen = false;
  @Input() showLastDataBar = false;
  @Input() lastDataRefreshLabel = '';

  @Output() navigate = new EventEmitter<ShellRoute>();
  @Output() logoutClick = new EventEmitter<void>();
  @Output() resetAlarms = new EventEmitter<void>();
  @Output() toggleMobileMore = new EventEmitter<void>();
  @Output() closeMobileMore = new EventEmitter<void>();

  mobileNavMoreActive(): boolean {
    return shellMoreActive(this.shellRoute);
  }

  nav(section: ShellRoute): void {
    this.navigate.emit(section);
  }

  onSearchInput(value: string): void {
    this.searchQuery = value;
    this.searchQueryChange.emit(value);
  }
}
