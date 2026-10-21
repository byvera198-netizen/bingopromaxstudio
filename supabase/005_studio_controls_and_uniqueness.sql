-- Bingo ProMax Studio: control completo de cuentas, partidas, encabezados,
-- marcas de agua y unicidad persistente de cartones.
-- Ejecutar después de 004_sales_clients.sql.

alter table public.studio_games add column if not exists active_block_codes jsonb not null default '[]'::jsonb;
alter table public.studio_games add column if not exists prize_plan jsonb not null default '[]'::jsonb;
alter table public.studio_games add column if not exists header_id uuid;
alter table public.studio_games add column if not exists header_text text not null default '';
alter table public.studio_games add column if not exists watermark_id uuid;

create table if not exists public.studio_headers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  name text not null,
  content text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists public.studio_watermarks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  distributor_id uuid not null references public.studio_distributors(id) on delete cascade,
  seller_id uuid references public.studio_sellers(id) on delete cascade,
  name text not null,
  text_value text not null,
  opacity numeric(4,3) not null default 0.12 check (opacity >= 0.03 and opacity <= 0.30),
  position text not null default 'bottom-right' check (position in ('top-left', 'top-right', 'bottom-left', 'bottom-right')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_card_signatures (
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  signature text not null,
  card_id text not null,
  block_code text not null references public.studio_blocks(code) on delete cascade,
  sheet_code text not null default '',
  created_at timestamptz not null default now(),
  primary key (tenant_id, signature)
);

create index if not exists studio_headers_tenant_idx on public.studio_headers(tenant_id, active, name);
create index if not exists studio_watermarks_tenant_idx on public.studio_watermarks(tenant_id, distributor_id, seller_id);
create index if not exists studio_card_signatures_block_idx on public.studio_card_signatures(tenant_id, block_code);
create unique index if not exists studio_card_signatures_card_id_idx
  on public.studio_card_signatures(tenant_id, card_id)
  where card_id <> '';

create or replace function public.studio_assert_block_cards_unique()
returns trigger language plpgsql security definer set search_path = public
as $function$
declare
  sheet_row jsonb;
  card_row jsonb;
  signature_value text;
begin
  delete from public.studio_card_signatures where tenant_id = new.tenant_id and block_code = new.code;
  if new.payload ? 'sheets' then
    for sheet_row in select value from jsonb_array_elements(new.payload->'sheets') loop
      for card_row in select value from jsonb_array_elements(coalesce(sheet_row->'cards', '[]'::jsonb)) loop
        signature_value := md5(coalesce(card_row->'numbers', 'null'::jsonb)::text);
        if exists (
          select 1 from public.studio_card_signatures
          where tenant_id = new.tenant_id and signature = signature_value and block_code <> new.code
        ) then
          raise exception 'Cartón repetido: %', coalesce(card_row->>'id', 'sin número');
        end if;
        insert into public.studio_card_signatures(tenant_id, signature, card_id, block_code, sheet_code)
        values (new.tenant_id, signature_value, coalesce(card_row->>'id', ''), new.code, coalesce(sheet_row->>'code', ''));
      end loop;
    end loop;
  end if;
  return new;
end;
$function$;

drop trigger if exists studio_blocks_unique_cards on public.studio_blocks;
create trigger studio_blocks_unique_cards
before insert or update of tenant_id, payload, code on public.studio_blocks
for each row execute function public.studio_assert_block_cards_unique();

create or replace function public.studio_delete_admin(p_email text)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare
  normalized_email text := lower(trim(p_email));
  tenant_value uuid;
begin
  if public.studio_actor_role() <> 'developer' then raise exception 'Solo un desarrollador puede eliminar administradores'; end if;
  if normalized_email in ('byvera198@gmail.com', 'bveraalvear@gmail.com') then raise exception 'Las cuentas desarrolladoras iniciales no se pueden eliminar'; end if;
  select tenant_id into tenant_value from public.studio_members where lower(email) = normalized_email and role = 'admin';
  if tenant_value is null then raise exception 'Administrador no encontrado'; end if;
  update public.studio_members set active = false, updated_at = now() where lower(email) = normalized_email;
  update public.studio_tenants set active = false, updated_at = now() where id = tenant_value;
  update public.studio_distributors set active = false, updated_at = now() where tenant_id = tenant_value;
  update public.studio_sellers set active = false, updated_at = now() where tenant_id = tenant_value;
  return jsonb_build_object('email', normalized_email, 'deleted', true);
end;
$function$;

create or replace function public.studio_update_party_account(p_type text, p_id uuid, p_name text, p_email text, p_phone text default '', p_distributor_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare
  tenant_value uuid;
  old_email text;
  normalized_email text := lower(trim(p_email));
  party_name text := coalesce(nullif(trim(p_name), ''), normalized_email);
begin
  if public.studio_actor_role() not in ('developer', 'admin') then raise exception 'No tienes permisos para editar cuentas comerciales'; end if;
  if p_type not in ('distributor', 'seller') or normalized_email = '' then raise exception 'Cuenta comercial inválida'; end if;
  if p_type = 'distributor' then
    select tenant_id, email into tenant_value, old_email from public.studio_distributors where id = p_id;
    if tenant_value is null or not public.studio_can_access_tenant(tenant_value) then raise exception 'Distribuidor fuera de tu espacio'; end if;
    update public.studio_distributors set name = party_name, email = normalized_email, phone = coalesce(p_phone, ''), updated_at = now() where id = p_id;
  else
    select tenant_id, email into tenant_value, old_email from public.studio_sellers where id = p_id;
    if tenant_value is null or not public.studio_can_access_tenant(tenant_value) then raise exception 'Vendedor fuera de tu espacio'; end if;
    if p_distributor_id is not null and not exists (select 1 from public.studio_distributors where id = p_distributor_id and tenant_id = tenant_value and active = true) then raise exception 'Distribuidor inválido'; end if;
    update public.studio_sellers set name = party_name, email = normalized_email, phone = coalesce(p_phone, ''), distributor_id = coalesce(p_distributor_id, distributor_id), updated_at = now() where id = p_id;
  end if;
  if old_email is not null then
    update public.studio_members set email = normalized_email, display_name = party_name, updated_at = now() where lower(email) = lower(old_email) and tenant_id = tenant_value;
  end if;
  return jsonb_build_object('id', p_id, 'email', normalized_email, 'type', p_type, 'name', party_name);
exception when unique_violation then
  raise exception 'El correo ya existe dentro de este espacio';
end;
$function$;

create or replace function public.studio_delete_party_account(p_type text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare
  tenant_value uuid;
begin
  if public.studio_actor_role() not in ('developer', 'admin') then raise exception 'No tienes permisos para eliminar cuentas comerciales'; end if;
  if p_type = 'distributor' then
    select tenant_id into tenant_value from public.studio_distributors where id = p_id;
    if tenant_value is null or not public.studio_can_access_tenant(tenant_value) then raise exception 'Distribuidor fuera de tu espacio'; end if;
    update public.studio_distributors set active = false, updated_at = now() where id = p_id;
    update public.studio_sellers set active = false, updated_at = now() where distributor_id = p_id;
  elsif p_type = 'seller' then
    select tenant_id into tenant_value from public.studio_sellers where id = p_id;
    if tenant_value is null or not public.studio_can_access_tenant(tenant_value) then raise exception 'Vendedor fuera de tu espacio'; end if;
    update public.studio_sellers set active = false, updated_at = now() where id = p_id;
  else raise exception 'Tipo de cuenta inválido'; end if;
  update public.studio_members set active = false, updated_at = now() where party_type = p_type and party_id = p_id;
  return jsonb_build_object('id', p_id, 'type', p_type, 'deleted', true);
end;
$function$;

create or replace function public.studio_save_header(p_id uuid, p_tenant_id uuid, p_name text, p_content text, p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare header_row public.studio_headers;
begin
  if public.studio_actor_role() not in ('developer', 'admin') or not public.studio_can_access_tenant(p_tenant_id) then raise exception 'No puedes editar encabezados fuera de tu espacio'; end if;
  if p_id is null then
    insert into public.studio_headers(tenant_id, name, content, active) values (p_tenant_id, trim(p_name), coalesce(p_content, ''), coalesce(p_active, true)) returning * into header_row;
  else
    update public.studio_headers set name = trim(p_name), content = coalesce(p_content, ''), active = coalesce(p_active, true), updated_at = now() where id = p_id and tenant_id = p_tenant_id returning * into header_row;
  end if;
  if header_row.id is null then raise exception 'Encabezado no encontrado'; end if;
  return jsonb_build_object('id', header_row.id, 'name', header_row.name, 'content', header_row.content, 'active', header_row.active);
end;
$function$;

create or replace function public.studio_delete_header(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $function$
begin
  if not exists (select 1 from public.studio_headers where id = p_id and public.studio_can_access_tenant(tenant_id) and public.studio_actor_role() in ('developer', 'admin')) then raise exception 'Encabezado fuera de tu espacio'; end if;
  delete from public.studio_headers where id = p_id;
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$function$;

create or replace function public.studio_save_watermark(p_id uuid, p_tenant_id uuid, p_distributor_id uuid, p_seller_id uuid, p_name text, p_text text, p_opacity numeric, p_position text, p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare watermark_row public.studio_watermarks;
begin
  if public.studio_actor_role() not in ('developer', 'admin', 'distributor') or not public.studio_can_access_tenant(p_tenant_id) then raise exception 'No puedes editar marcas fuera de tu espacio'; end if;
  if not exists (select 1 from public.studio_distributors where id = p_distributor_id and tenant_id = p_tenant_id and active = true) then raise exception 'Distribuidor inválido'; end if;
  if public.studio_actor_role() = 'distributor' and not exists (select 1 from public.studio_members where lower(email) = public.studio_actor_email() and party_type = 'distributor' and party_id = p_distributor_id and active = true) then raise exception 'Solo puedes administrar tus propias marcas'; end if;
  if p_seller_id is not null and not exists (select 1 from public.studio_sellers where id = p_seller_id and tenant_id = p_tenant_id and distributor_id = p_distributor_id and active = true) then raise exception 'El vendedor no pertenece al distribuidor'; end if;
  if p_id is null then
    insert into public.studio_watermarks(tenant_id, distributor_id, seller_id, name, text_value, opacity, position, active) values (p_tenant_id, p_distributor_id, p_seller_id, trim(p_name), trim(p_text), p_opacity, p_position, coalesce(p_active, true)) returning * into watermark_row;
  else
    update public.studio_watermarks set distributor_id = p_distributor_id, seller_id = p_seller_id, name = trim(p_name), text_value = trim(p_text), opacity = p_opacity, position = p_position, active = coalesce(p_active, true), updated_at = now() where id = p_id and tenant_id = p_tenant_id returning * into watermark_row;
  end if;
  if watermark_row.id is null then raise exception 'Marca de agua no encontrada'; end if;
  return jsonb_build_object('id', watermark_row.id, 'distributor_id', watermark_row.distributor_id, 'seller_id', watermark_row.seller_id, 'name', watermark_row.name, 'text', watermark_row.text_value, 'opacity', watermark_row.opacity, 'position', watermark_row.position, 'active', watermark_row.active);
end;
$function$;

create or replace function public.studio_delete_watermark(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare owner_id uuid;
begin
  select distributor_id into owner_id from public.studio_watermarks where id = p_id and public.studio_can_access_tenant(tenant_id);
  if owner_id is null then raise exception 'Marca fuera de tu espacio'; end if;
  if public.studio_actor_role() = 'distributor' and not exists (select 1 from public.studio_members where lower(email) = public.studio_actor_email() and party_type = 'distributor' and party_id = owner_id and active = true) then raise exception 'Solo puedes eliminar tus propias marcas'; end if;
  delete from public.studio_watermarks where id = p_id;
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$function$;

grant execute on function public.studio_delete_admin(text) to authenticated;
grant execute on function public.studio_update_party_account(text, uuid, text, text, text, uuid) to authenticated;
grant execute on function public.studio_delete_party_account(text, uuid) to authenticated;
grant execute on function public.studio_save_header(uuid, uuid, text, text, boolean) to authenticated;
grant execute on function public.studio_delete_header(uuid) to authenticated;
grant execute on function public.studio_save_watermark(uuid, uuid, uuid, uuid, text, text, numeric, text, boolean) to authenticated;
grant execute on function public.studio_delete_watermark(uuid) to authenticated;

alter table public.studio_headers enable row level security;
alter table public.studio_watermarks enable row level security;
alter table public.studio_card_signatures enable row level security;

drop policy if exists studio_headers_access on public.studio_headers;
create policy studio_headers_access on public.studio_headers for select using (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_watermarks_access on public.studio_watermarks;
create policy studio_watermarks_access on public.studio_watermarks for select using (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_card_signatures_access on public.studio_card_signatures;
create policy studio_card_signatures_access on public.studio_card_signatures for select using (public.studio_can_access_tenant(tenant_id));

-- Cuenta administrativa solicitada y vendedor solicitado.
do $seed$
declare
  admin_tenant uuid;
  distributor_value uuid;
  seller_value uuid;
begin
  select id into admin_tenant from public.studio_tenants where owner_email = 'byvera980@gmail.com' limit 1;
  if admin_tenant is null then
    insert into public.studio_tenants(name, slug, owner_email) values ('Operación byvera980', 'tenant-byvera980', 'byvera980@gmail.com') returning id into admin_tenant;
  else
    update public.studio_tenants set active = true, name = 'Operación byvera980' where id = admin_tenant;
  end if;
  insert into public.studio_members(email, role, active, permissions, tenant_id, display_name)
  values ('byvera980@gmail.com', 'admin', true, '{"dashboard":true,"generator":true,"blocks":true,"games":true,"patterns":true,"integration":true,"users":true,"audit":true}'::jsonb, admin_tenant, 'Administrador byvera980')
  on conflict (email) do update set role = 'admin', active = true, tenant_id = excluded.tenant_id, permissions = excluded.permissions, display_name = excluded.display_name, updated_at = now();
  select id into distributor_value from public.studio_distributors where tenant_id = admin_tenant order by created_at limit 1;
  if distributor_value is null then
    insert into public.studio_distributors(tenant_id, name, email, phone) values (admin_tenant, 'Distribución inicial', 'distribucion-inicial@bingo.local', '') returning id into distributor_value;
  end if;
  select id into seller_value from public.studio_sellers where tenant_id = admin_tenant and lower(email) = 'moavxy@gmail.com' limit 1;
  if seller_value is null then
    insert into public.studio_sellers(tenant_id, distributor_id, name, email, phone) values (admin_tenant, distributor_value, 'Vendedor moavxy', 'moavxy@gmail.com', '') returning id into seller_value;
  else
    update public.studio_sellers set active = true, distributor_id = distributor_value where id = seller_value;
  end if;
  insert into public.studio_members(email, role, active, permissions, tenant_id, party_type, party_id, display_name)
  values ('moavxy@gmail.com', 'seller', true, '{"dashboard":true,"blocks":true,"games":true,"integration":true}'::jsonb, admin_tenant, 'seller', seller_value, 'Vendedor moavxy')
  on conflict (email) do update set role = 'seller', active = true, tenant_id = excluded.tenant_id, party_type = 'seller', party_id = excluded.party_id, permissions = excluded.permissions, display_name = excluded.display_name, updated_at = now();
end;
$seed$;
