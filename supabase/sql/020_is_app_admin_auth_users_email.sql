/*
  is_app_admin() debe devolver true para cualquier email listado en public.admin_emails.

  Problema habitual:
  - Si solo se ejecutó 011_admin_app.sql, la función compara contra UN email fijo; los admins
    agregados en la tabla no tienen permisos.
  - Si auth.jwt() no trae la claim "email" en algunos flujos, la comparación falla.

  Solución: resolver el email desde auth.users (SECURITY DEFINER) y caer a JWT si hace falta.

  Requisitos: tabla public.admin_emails (012_admin_emails.sql). Ejecutar en SQL Editor completo.
*/

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_emails e
    where lower(trim(e.email)) = lower(trim(coalesce(
      (select u.email from auth.users u where u.id = auth.uid()),
      auth.jwt() ->> 'email',
      ''
    )))
  );
$$;

grant execute on function public.is_app_admin() to authenticated;

notify pgrst, 'reload schema';
