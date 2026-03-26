import { Component, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { mapSignInError } from '../core/auth-errors';
import { isSupabaseConfigured } from '../core/supabase-config';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss'],
})
export class LoginComponent implements OnInit {
  readonly supabaseReady = isSupabaseConfigured();

  readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
    remember: [false],
  });

  submitting = false;
  errorMessage: string | null = null;
  successMessage: string | null = null;

  constructor(
    private readonly fb: FormBuilder,
    private readonly auth: AuthService,
    private readonly router: Router,
    private readonly route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get('restablecida') === '1') {
      this.successMessage = 'Contraseña actualizada. Iniciá sesión con la nueva.';
    }
  }

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
      .signIn(email!, password!)
      .then(({ error }) => {
        this.submitting = false;
        if (error) {
          this.errorMessage = mapSignInError(error.message);
          return;
        }
        void this.router.navigate(['/dashboard']);
      })
      .catch(() => {
        this.submitting = false;
        this.errorMessage =
          'No se pudo conectar. Revisá la URL y la clave en environment.ts y tu conexión.';
      });
  }
}
