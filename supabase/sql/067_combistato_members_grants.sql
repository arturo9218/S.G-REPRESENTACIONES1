-- Si ya ejecutaste 066 antes de agregar el GRANT, corré solo esto en Supabase SQL Editor.
grant select on public.combistato_members to authenticated;
notify pgrst, 'reload schema';
