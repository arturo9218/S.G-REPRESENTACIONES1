import { TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { SwUpdate } from '@angular/service-worker';
import { EMPTY } from 'rxjs';
import { AppComponent } from './app.component';
import { ConnectivityService } from './core/connectivity.service';

describe('AppComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      declarations: [AppComponent],
      providers: [
        ConnectivityService,
        {
          provide: SwUpdate,
          useValue: {
            isEnabled: false,
            versionUpdates: EMPTY,
            checkForUpdate: () => Promise.resolve(false),
            activateUpdate: () => Promise.resolve(),
          },
        },
      ],
    })
  );

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
