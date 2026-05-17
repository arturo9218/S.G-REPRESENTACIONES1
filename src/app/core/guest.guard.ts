import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Evita que un usuario ya autenticado entre a login/registro. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  let session = await auth.getSession();
  if (!session) {
    // Evita rebote visual login/dashboard si la sesión demora en restaurarse.
    for (let i = 0; i < 6 && !session; i++) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      session = await auth.getSession();
    }
  }
  if (session) {
    return router.parseUrl('/inicio');
  }
  return true;
};
