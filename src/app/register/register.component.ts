import { Component } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { mapSignUpError } from '../core/auth-errors';
import { isSupabaseConfigured } from '../core/supabase-config';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const pass = group.get('password');
  const confirm = group.get('confirmPassword');
  if (!pass || !confirm) return null;
  if (confirm.value === '' || pass.value === confirm.value) return null;
  return { passwordMismatch: true };
}

@Component({
  selector: 'app-register',
  templateUrl: './register.component.html',
  styleUrls: ['../login/login.component.scss'],
})
export class RegisterComponent {
  readonly supabaseReady = isSupabaseConfigured();

  readonly form = this.fb.group(
    {
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(6)]],
      confirmPassword: ['', [Validators.required]],
    },
    { validators: passwordsMatch }
  );

  submitting = false;
  errorMessage: string | null = null;
  successMessage: string | null = null;

  constructor(
    private readonly fb: FormBuilder,
    private readonly auth: AuthService,
    private readonly router: Router
  ) {}

  onSubmit(): void {
    this.errorMessage = null;
    this.successMessage = null;

    if (!this.supabaseReady) {
      this.errorMessage =
        'Configurá la URL y la clave anon de Supabase en src/environments/environment.ts';
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { email, password } = this.form.getRawValue();
    this.submitting = true;

    void this.auth
      .signUp(email!, password!)
      .then(({ data, error }) => {
        this.submitting = false;
        if (error) {
          this.errorMessage = mapSignUpError(error.message);
          return;
        }
        if (data.session) {
          void this.router.navigate(['/dashboard']);
          return;
        }
        this.successMessage =
          'Cuenta creada en Supabase. Si pedís confirmar el correo, revisá el email y luego iniciá sesión. Podés ver el usuario en el panel de Supabase → Authentication → Users.';
        this.form.reset();
      })
      .catch(() => {
        this.submitting = false;
        this.errorMessage =
          'No se pudo conectar. Revisá internet, la URL en environment.ts y que el proyecto Supabase esté activo.';
      });
  }
}
