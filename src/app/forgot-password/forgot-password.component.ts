import { Component } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { AuthService } from '../core/auth.service';
import { mapRecoveryEmailError } from '../core/auth-errors';
import { isSupabaseConfigured } from '../core/supabase-config';

@Component({
  selector: 'app-forgot-password',
  templateUrl: './forgot-password.component.html',
  styleUrls: ['../login/login.component.scss'],
})
export class ForgotPasswordComponent {
  readonly supabaseReady = isSupabaseConfigured();

  readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
  });

  submitting = false;
  errorMessage: string | null = null;
  /** Tras enviar: no revelamos si el correo existe (buena práctica). */
  emailSent = false;

  constructor(
    private readonly fb: FormBuilder,
    public readonly auth: AuthService
  ) {}

  onSubmit(): void {
    this.errorMessage = null;
    this.emailSent = false;

    if (!this.supabaseReady) {
      this.errorMessage =
        'Configurá Supabase en src/environments/environment.ts';
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const email = this.form.get('email')!.value as string;
    this.submitting = true;

    void this.auth
      .resetPasswordForEmail(email)
      .then(({ error }) => {
        this.submitting = false;
        if (error) {
          this.errorMessage = mapRecoveryEmailError(error.message);
          return;
        }
        this.emailSent = true;
        this.form.reset();
      })
      .catch(() => {
        this.submitting = false;
        this.errorMessage = 'No se pudo enviar el correo. Revisá tu conexión.';
      });
  }
}
