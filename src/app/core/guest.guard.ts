import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Evita que un usuario ya autenticado entre a login/registro. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const session = await auth.getSession();
  if (session) {
    await router.navigate(['/dashboard']);
    return false;
  }
  return true;
};
