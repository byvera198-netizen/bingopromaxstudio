-- Garantiza el acceso total de las cuentas desarrolladoras de Bingo ProMax Studio.
-- Ejecutar después de 008_global_card_code_uniqueness.sql.

insert into public.studio_members(
  email,
  role,
  active,
  permissions,
  tenant_id,
  party_type,
  party_id,
  display_name
)
values
(
  'byvera198@gmail.com',
  'developer',
  true,
  '{"dashboard":true,"generator":true,"blocks":true,"games":true,"patterns":true,"integration":true,"users":true,"audit":true}'::jsonb,
  null,
  null,
  null,
  'Desarrollador principal'
),
(
  'bveraalvear@gmail.com',
  'developer',
  true,
  '{"dashboard":true,"generator":true,"blocks":true,"games":true,"patterns":true,"integration":true,"users":true,"audit":true}'::jsonb,
  null,
  null,
  null,
  'Desarrollador asociado'
)
on conflict (email) do update set
  role = 'developer',
  active = true,
  permissions = excluded.permissions,
  tenant_id = null,
  party_type = null,
  party_id = null,
  display_name = excluded.display_name,
  updated_at = now();
