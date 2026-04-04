-- Asegura que `updated_at` (actualizado_en en la UI) se renueve en cada cambio de umbrales.
-- Sin esto, el DEFAULT now() solo aplica al INSERT; los UPDATE desde la app no tocaban la fecha.

create or replace function public.device_thresholds_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_device_thresholds_updated_at on public.device_thresholds;

create trigger trg_device_thresholds_updated_at
  before update on public.device_thresholds
  for each row
  execute function public.device_thresholds_set_updated_at();

notify pgrst, 'reload schema';
