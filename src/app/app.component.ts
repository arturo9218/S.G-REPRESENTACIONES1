import { Component, OnDestroy, OnInit } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { Subscription, fromEvent, interval } from 'rxjs';
import { filter } from 'rxjs/operators';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit, OnDestroy {
  /** Hay build nuevo en el servidor; el SW ya lo descargó y puede activarse. */
  updateAvailable = false;

  private versionSub?: Subscription;
  private pollSub?: Subscription;
  private visSub?: Subscription;

  constructor(private readonly swUpdate: SwUpdate) {}

  ngOnInit(): void {
    if (!environment.production || !this.swUpdate.isEnabled) {
      return;
    }

    this.versionSub = this.swUpdate.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => {
        this.updateAvailable = true;
      });

    void this.swUpdate.checkForUpdate();

    this.pollSub = interval(5 * 60 * 1000).subscribe(() => {
      void this.swUpdate.checkForUpdate();
    });

    this.visSub = fromEvent(document, 'visibilitychange').subscribe(() => {
      if (document.visibilityState === 'visible') {
        void this.swUpdate.checkForUpdate();
      }
    });
  }

  ngOnDestroy(): void {
    this.versionSub?.unsubscribe();
    this.pollSub?.unsubscribe();
    this.visSub?.unsubscribe();
  }

  dismissUpdatePrompt(): void {
    this.updateAvailable = false;
  }

  async activateNewVersion(): Promise<void> {
    try {
      await this.swUpdate.activateUpdate();
      document.location.reload();
    } catch {
      document.location.reload();
    }
  }
}
