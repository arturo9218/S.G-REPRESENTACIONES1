-- Catálogo de refrigerantes para PR500 (tabla P-T de saturación).
-- Presión absoluta en bar_abs y temperatura de saturación en °C.
-- Fuente: tablas técnicas de fabricantes (DuPont/Freon, Hudson, referencias HVAC),
-- usando curva DEW para mezclas (R404A, R507A) por consistencia con cálculo de superheat.

create table if not exists public.pr500_refrigerants (
  code smallint primary key,
  name text not null unique
);

create table if not exists public.pr500_refrigerant_pt_points (
  refrigerant_code smallint not null references public.pr500_refrigerants(code) on delete cascade,
  curve_kind text not null default 'dew',
  pressure_bar_abs double precision not null,
  sat_temp_c double precision not null,
  primary key (refrigerant_code, curve_kind, pressure_bar_abs)
);

alter table public.pr500_refrigerant_pt_points
  add column if not exists curve_kind text not null default 'dew';

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'pr500_refrigerant_pt_points'
      and constraint_name = 'pr500_refrigerant_pt_points_pkey'
  ) then
    alter table public.pr500_refrigerant_pt_points
      drop constraint pr500_refrigerant_pt_points_pkey;
  end if;
exception when undefined_object then
  null;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'pr500_refrigerant_pt_points'
      and constraint_name = 'pr500_refrigerant_pt_points_pkey'
  ) then
    alter table public.pr500_refrigerant_pt_points
      add constraint pr500_refrigerant_pt_points_pkey
      primary key (refrigerant_code, curve_kind, pressure_bar_abs);
  end if;
end $$;

insert into public.pr500_refrigerants (code, name) values
  (1, 'R134a'),
  (2, 'R404A'),
  (3, 'R22'),
  (4, 'R410A'),
  (5, 'R507A')
on conflict (code) do update set name = excluded.name;

insert into public.pr500_refrigerant_pt_points (refrigerant_code, curve_kind, pressure_bar_abs, sat_temp_c) values
  -- R134a (dew/sat)
  (1, 'dew', 0.512, -40), (1, 'dew', 0.844, -30), (1, 'dew', 1.327, -20), (1, 'dew', 2.006, -10),
  (1, 'dew', 2.928, 0), (1, 'dew', 4.146, 10), (1, 'dew', 5.717, 20), (1, 'dew', 7.701, 30),
  (1, 'dew', 10.166, 40), (1, 'dew', 13.173, 50), (1, 'dew', 16.818, 60),
  -- R404A (dew)
  (2, 'dew', 1.31, -40), (2, 'dew', 2.06, -30), (2, 'dew', 3.00, -20), (2, 'dew', 4.28, -10),
  (2, 'dew', 6.00, 0), (2, 'dew', 8.16, 10), (2, 'dew', 10.84, 20), (2, 'dew', 14.14, 30),
  (2, 'dew', 18.15, 40), (2, 'dew', 22.96, 50), (2, 'dew', 28.71, 60),
  -- R22 (sat)
  (3, 'dew', 1.30, -40), (3, 'dew', 1.98, -30), (3, 'dew', 2.95, -20), (3, 'dew', 4.25, -10),
  (3, 'dew', 5.96, 0), (3, 'dew', 8.15, 10), (3, 'dew', 10.90, 20), (3, 'dew', 14.29, 30),
  (3, 'dew', 18.42, 40), (3, 'dew', 23.40, 50), (3, 'dew', 29.35, 60),
  -- R410A (sat)
  (4, 'dew', 2.00, -40), (4, 'dew', 3.00, -30), (4, 'dew', 4.30, -20), (4, 'dew', 5.94, -10),
  (4, 'dew', 7.92, 0), (4, 'dew', 10.30, 10), (4, 'dew', 13.16, 20), (4, 'dew', 16.58, 30),
  (4, 'dew', 20.65, 40), (4, 'dew', 25.47, 50), (4, 'dew', 31.14, 60),
  -- R507A (dew)
  (5, 'dew', 1.38, -40), (5, 'dew', 1.98, -30), (5, 'dew', 2.84, -20), (5, 'dew', 4.06, -10),
  (5, 'dew', 5.66, 0), (5, 'dew', 7.72, 10), (5, 'dew', 10.31, 20), (5, 'dew', 13.50, 30),
  (5, 'dew', 17.39, 40), (5, 'dew', 22.06, 50), (5, 'dew', 27.63, 60)
on conflict (refrigerant_code, curve_kind, pressure_bar_abs)
do update set sat_temp_c = excluded.sat_temp_c;

create index if not exists idx_pr500_pt_ref_press
  on public.pr500_refrigerant_pt_points (refrigerant_code, curve_kind, pressure_bar_abs);

-- Catálogo público de solo lectura para usuarios autenticados.
grant select on public.pr500_refrigerants to authenticated;
grant select on public.pr500_refrigerant_pt_points to authenticated;

notify pgrst, 'reload schema';
