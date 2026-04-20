-- Permite a editores (invitados) actualizar solo las etiquetas de sensor en `devices`
-- sin dar UPDATE general sobre la fila (RLS de dueño sigue aplicando al resto).
-- Requisito: 029_device_members_chart_markers.sql (user_can_edit_device).

create or replace function public.update_device_sensor_labels(
  p_device_id uuid,
  p_sensor_1_label text,
  p_sensor_2_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not public.user_can_edit_device(p_device_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.devices
  set
    sensor_1_label = p_sensor_1_label,
    sensor_2_label = p_sensor_2_label
  where id = p_device_id;
end;
$$;

grant execute on function public.update_device_sensor_labels(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
