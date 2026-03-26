import { Component, OnDestroy, OnInit } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { isSupabaseConfigured } from '../core/supabase-config';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const pass = group.get('password');
  const confirm = group.get('confirmPassword');
  if (!pass || !confirm) return null;
  if (confirm.value === '' || pass.value === confirm.value) return null;
  return { passwordMismatch: true };
}

@Component({
  selector: 'app-reset-password',
  templateUrl: './reset-password.component.html',
  styleUrls: ['../login/login.component.scss'],
})
export class ResetPasswordComponent implements OnInit, OnDestroy {
  readonly form = this.fb.group(
    {
      password: ['', [Validators.required, Validators.minLength(6)]],
      confirmPassword: ['', [Validators.required]],
    },
    { validators: passwordsMatch }
  );

  submitting = false;
  errorMessage: string | null = null;
  /** Enlace del mail procesado: podemos cambiar la contraseña. */
  recoveryReady = false;
  /** Enlace inválido o expirado (tras esperar al cliente de Supabase). */
  invalidLink = false;

  readonly configMissing = !isSupabaseConfigured();

  private authSub: { unsubscribe: () => void } | null = null;
  private invalidTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly fb: FormBuilder,
    private readonly auth: AuthService,
    private readonly router: Router
  ) {}

  ngOnInit(): void {
    if (this.configMissing) {
      return;
    }

    const { data } = this.auth.client.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        this.recoveryReady = true;
        this.invalidLink = false;
        this.clearInvalidTimer();
      }
    });
    this.authSub = data.subscription;

    const win = typeof window !== 'undefined' ? window : null;
    const hash = win?.location.hash ?? '';
    const hashLooksRecovery =
      hash.includes('access_token') && hash.toLowerCase().includes('type=recovery');

    if (win && win.location.search.includes('code=')) {
      void this.auth.client.auth.exchangeCodeForSession(win.location.href).then(({ error }) => {
        if (!error) {
          this.recoveryReady = true;
          this.invalidLink = false;
          this.clearInvalidTimer();
        }
      });
    }

    if (hashLooksRecovery) {
      this.recoveryReady = true;
      this.invalidLink = false;
      this.clearInvalidTimer();
    }

    void this.auth.getSession().then((session) => {
      if (session && hash.includes('access_token')) {
        this.recoveryReady = true;
        this.invalidLink = false;
        this.clearInvalidTimer();
      }
      if (session && hashLooksRecovery) {
        this.recoveryReady = true;
        this.invalidLink = false;
        this.clearInvalidTimer();
      }
    });

    this.invalidTimer = setTimeout(() => {
      if (!this.recoveryReady) {
        this.invalidLink = true;
      }
    }, 8000);
  }

  ngOnDestroy(): void {
    this.authSub?.unsubscribe();
    this.clearInvalidTimer();
  }

  private clearInvalidTimer(): void {
    if (this.invalidTimer !== null) {
      clearTimeout(this.invalidTimer);
      this.invalidTimer = null;
    }
  }

  onSubmit(): void {
    this.errorMessage = null;

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const password = this.form.get('password')!.value as string;
    this.submitting = true;

    void this.auth
      .updatePassword(password)
      .then(({ error }) => {
        this.submitting = false;
        if (error) {
          this.errorMessage = error.message;
          return;
        }
        void this.auth.signOut().then(() => {
          void this.router.navigate(['/login'], {
            queryParams: { restablecida: '1' },
          });
        });
      })
      .catch(() => {
        this.submitting = false;
        this.errorMessage = 'No se pudo actualizar. Probá pedir un enlace nuevo.';
      });
  }
}
