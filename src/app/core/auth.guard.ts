import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  let session = await auth.getSession();
  if (!session) {
    // En pestaña nueva la restauración de sesión puede demorar unos segundos.
    const attempts = 12; // ~6s
    for (let i = 0; i < attempts && !session; i++) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      session = await auth.getSession();
    }
  }
  if (!session) {
    const attempted = router.url;
    const returnUrl =
      attempted && attempted !== '/login' && !attempted.startsWith('/login?') ? attempted : null;
    return router.createUrlTree(['/login'], {
      queryParams: returnUrl ? { returnUrl } : {},
    });
  }
  return true;
};
