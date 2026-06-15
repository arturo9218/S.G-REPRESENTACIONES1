/** Rutas de sección del layout autenticado (sincronizadas con la URL). */
export type ShellRoute =
  | 'inicio'
  | 'devices'
  | 'equipment'
  | 'alerts'
  | 'ayuda'
  | 'herramientas'
  | 'comunidad'
  | 'presupuestos'
  | 'settings';

export const SHELL_MORE_ROUTES: ShellRoute[] = [
  'equipment',
  'herramientas',
  'comunidad',
  'presupuestos',
  'settings',
];

export function shellMoreActive(route: ShellRoute): boolean {
  return SHELL_MORE_ROUTES.includes(route);
}
