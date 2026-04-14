-- Branding por usuario (nombre empresa + logotipo) para cabecera de PDF.
-- Ejecutar después de 020 (is_app_admin) y 021+.

create table if not exists public.user_branding (
  user_id uuid primary key references auth.users (id) on delete cascade,
  company_name text,
  logo_storage_path text,
  updated_at timestamptz not null default now()
);

comment on table public.user_branding is 'Configuración visual por usuario para reportes/PDF.';

alter table public.user_branding enable row level security;

drop policy if exists "owner_select_user_branding" on public.user_branding;
create policy "owner_select_user_branding"
  on public.user_branding for select
  using (user_id = auth.uid());

drop policy if exists "owner_insert_user_branding" on public.user_branding;
create policy "owner_insert_user_branding"
  on public.user_branding for insert
  with check (user_id = auth.uid());

drop policy if exists "owner_update_user_branding" on public.user_branding;
create policy "owner_update_user_branding"
  on public.user_branding for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "owner_delete_user_branding" on public.user_branding;
create policy "owner_delete_user_branding"
  on public.user_branding for delete
  using (user_id = auth.uid());

drop policy if exists "admin_select_user_branding" on public.user_branding;
create policy "admin_select_user_branding"
  on public.user_branding for select
  using (public.is_app_admin());

drop policy if exists "admin_manage_user_branding" on public.user_branding;
create policy "admin_manage_user_branding"
  on public.user_branding for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding-logos',
  'branding-logos',
  true,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "branding_logos_select" on storage.objects;
create policy "branding_logos_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'branding-logos'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.is_app_admin()
    )
  );

drop policy if exists "branding_logos_insert" on storage.objects;
create policy "branding_logos_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'branding-logos'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.is_app_admin()
    )
  );

drop policy if exists "branding_logos_update" on storage.objects;
create policy "branding_logos_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'branding-logos'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.is_app_admin()
    )
  );

drop policy if exists "branding_logos_delete" on storage.objects;
create policy "branding_logos_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'branding-logos'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.is_app_admin()
    )
  );

drop policy if exists "branding_logos_public_read" on storage.objects;
create policy "branding_logos_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'branding-logos');

notify pgrst, 'reload schema';
