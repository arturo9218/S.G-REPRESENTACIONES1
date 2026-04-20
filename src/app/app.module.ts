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
