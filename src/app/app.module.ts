import { ErrorHandler, NgModule } from '@angular/core';
import { createErrorHandler } from '@sentry/angular-ivy';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ServiceWorkerModule } from '@angular/service-worker';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { LoginComponent } from './login/login.component';
import { RegisterComponent } from './register/register.component';
import { ForgotPasswordComponent } from './forgot-password/forgot-password.component';
import { ResetPasswordComponent } from './reset-password/reset-password.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { ChartAnalysisComponent } from './chart-analysis/chart-analysis.component';
import { CombistatoSettingsComponent } from './combistato/combistato-settings.component';
import { CombistatoChartComponent } from './combistato-chart/combistato-chart.component';
import { Pr500SettingsComponent } from './pr500/pr500-settings.component';
import { Pr500ChartComponent } from './pr500-chart/pr500-chart.component';
import { InicioPageComponent } from './inicio/inicio-page.component';
import { environment } from '../environments/environment';

export function rootErrorHandlerFactory(): ErrorHandler {
  const dsn = typeof environment.sentryDsn === 'string' ? environment.sentryDsn.trim() : '';
  if (dsn) {
    return createErrorHandler({ showDialog: false, logErrors: true });
  }
  return new ErrorHandler();
}

@NgModule({
  declarations: [
    AppComponent,
    LoginComponent,
    RegisterComponent,
    ForgotPasswordComponent,
    ResetPasswordComponent,
    DashboardComponent,
    ChartAnalysisComponent,
    CombistatoSettingsComponent,
    CombistatoChartComponent,
    Pr500SettingsComponent,
    Pr500ChartComponent,
    InicioPageComponent,
  ],
  imports: [
    BrowserModule,
    FormsModule,
    ReactiveFormsModule,
    AppRoutingModule,
    ServiceWorkerModule.register('ngsw-worker.js', {
      enabled: environment.serviceWorkerEnabled,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
  providers: [{ provide: ErrorHandler, useFactory: rootErrorHandlerFactory }],
  bootstrap: [AppComponent]
})
export class AppModule { }
