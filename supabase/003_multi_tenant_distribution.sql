-- Bingo ProMax Studio: aislamiento por administrador y red comercial.
-- Ejecutar después de 001_studio.sql y 002_backend_hardening.sql.

create table if not exists public.studio_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.studio_tenants (id, name, slug, owner_email)
values ('00000000-0000-4000-8000-000000000001', 'Operación de desarrolladores', 'developers', 'byvera198@gmail.com')
on conflict (id) do nothing;

alter table public.studio_members drop constraint if exists studio_members_role_check;
alter table public.studio_members add constraint studio_members_role_check
  check (role in ('developer', 'admin', 'operator', 'distributor', 'seller'));
alter table public.studio_members add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;
alter table public.studio_members add column if not exists party_type text check (party_type in ('distributor', 'seller'));
alter table public.studio_members add column if not exists party_id uuid;
alter table public.studio_members add column if not exists display_name text not null default '';

alter table public.studio_campaigns add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;
alter table public.studio_blocks add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;
alter table public.studio_patterns add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;
alter table public.studio_games add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;
alter table public.studio_generation_jobs add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;
alter table public.studio_audit_events add column if not exists tenant_id uuid references public.studio_tenants(id) on delete cascade;

update public.studio_campaigns set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null;
update public.studio_blocks set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null;
update public.studio_patterns set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null;
update public.studio_games set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null;
update public.studio_generation_jobs set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null;
update public.studio_audit_events set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null;
update public.studio_members set tenant_id = '00000000-0000-4000-8000-000000000001' where tenant_id is null and role <> 'developer';

create table if not exists public.studio_distributors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  name text not null,
  email text not null,
  phone text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table if not exists public.studio_sellers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  distributor_id uuid not null references public.studio_distributors(id) on delete restrict,
  name text not null,
  email text not null,
  phone text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table if not exists public.studio_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  name text not null,
  email text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_blocks add column if not exists holder_type text check (holder_type in ('admin', 'distributor', 'seller'));
alter table public.studio_blocks add column if not exists holder_id uuid;
alter table public.studio_blocks add column if not exists holder_name text not null default '';

create table if not exists public.studio_block_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  block_code text not null references public.studio_blocks(code) on delete cascade,
  from_type text not null check (from_type in ('admin', 'distributor', 'seller', 'inventory')),
  from_id uuid,
  from_name text not null default '',
  to_type text not null check (to_type in ('distributor', 'seller')),
  to_id uuid not null,
  to_name text not null default '',
  notes text not null default '',
  transferred_by text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.studio_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.studio_tenants(id) on delete cascade,
  block_code text not null references public.studio_blocks(code) on delete restrict,
  seller_type text not null check (seller_type in ('distributor', 'seller')),
  seller_id uuid not null,
  client_id uuid references public.studio_clients(id) on delete set null,
  sheets_sold integer not null check (sheets_sold > 0),
  cards_sold integer not null check (cards_sold > 0),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  notes text not null default '',
  sold_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now()
);

create or replace function public.studio_actor_email()
returns text language sql stable security definer set search_path = public
as $$ select lower(coalesce(auth.jwt() ->> 'email', '')); $$;

create or replace function public.studio_actor_tenant()
returns uuid language sql stable security definer set search_path = public
as $$
  select tenant_id from public.studio_members
  where lower(email) = public.studio_actor_email() and active = true
  limit 1;
$$;

create or replace function public.studio_login_allowed(p_email text)
returns boolean language sql stable security definer set search_path = public
as $$
  select lower(trim(p_email)) in ('byvera198@gmail.com', 'bveraalvear@gmail.com')
    or exists (select 1 from public.studio_members where lower(email) = lower(trim(p_email)) and active = true);
$$;
grant execute on function public.studio_login_allowed(text) to anon, authenticated;

create or replace function public.studio_can_access_tenant(target_tenant uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(
    public.studio_actor_role() = 'developer'
    or (target_tenant is not null and public.studio_actor_tenant() = target_tenant), false
  );
$$;

create or replace function public.studio_create_admin(p_email text, p_name text, p_tenant_name text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  normalized_email text := lower(trim(p_email));
  tenant_row public.studio_tenants;
  member_row public.studio_members;
begin
  if public.studio_actor_role() <> 'developer' then raise exception 'Solo un desarrollador puede crear administradores'; end if;
  if normalized_email = '' or position('@' in normalized_email) < 2 then raise exception 'Correo de administrador inválido'; end if;
  if exists (select 1 from public.studio_members where lower(email) = normalized_email) then raise exception 'El correo ya tiene un acceso'; end if;
  insert into public.studio_tenants(name, slug, owner_email)
  values (coalesce(nullif(trim(p_tenant_name), ''), 'Operación ' || normalized_email), 'tenant-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), normalized_email)
  returning * into tenant_row;
  insert into public.studio_members(email, role, active, permissions, tenant_id, display_name)
  values (normalized_email, 'admin', true, '{"dashboard":true,"generator":true,"blocks":true,"games":true,"patterns":true,"integration":true,"users":true,"audit":true}'::jsonb, tenant_row.id, coalesce(nullif(trim(p_name), ''), normalized_email))
  returning * into member_row;
  return jsonb_build_object('tenant_id', tenant_row.id, 'email', member_row.email, 'role', member_row.role, 'name', member_row.display_name);
end;
$$;

drop function if exists public.studio_create_party_account(text, text, text, text, uuid);
create or replace function public.studio_create_party_account(p_type text, p_name text, p_email text, p_phone text default '', p_distributor_id uuid default null, p_tenant_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  normalized_email text := lower(trim(p_email));
  tenant_id_value uuid := coalesce(p_tenant_id, public.studio_actor_tenant());
  party_id_value uuid;
  display_name_value text := coalesce(nullif(trim(p_name), ''), normalized_email);
begin
  if public.studio_actor_role() not in ('developer', 'admin') then raise exception 'No tienes permisos para crear distribuidores o vendedores'; end if;
  if public.studio_actor_role() = 'developer' and p_tenant_id is not null and not exists (select 1 from public.studio_tenants where id = p_tenant_id and active = true) then raise exception 'Espacio de administrador inválido'; end if;
  if public.studio_actor_role() = 'admin' and p_tenant_id is not null and p_tenant_id is distinct from public.studio_actor_tenant() then raise exception 'No puedes operar el espacio de otro administrador'; end if;
  if public.studio_actor_role() = 'developer' and tenant_id_value is null then raise exception 'Selecciona un administrador antes de crear la cuenta'; end if;
  if p_type not in ('distributor', 'seller') then raise exception 'Tipo de cuenta inválido'; end if;
  if p_type = 'distributor' then
    insert into public.studio_distributors(tenant_id, name, email, phone) values (tenant_id_value, display_name_value, normalized_email, coalesce(p_phone, '')) returning id into party_id_value;
  else
    if p_distributor_id is null then raise exception 'El vendedor debe pertenecer a un distribuidor'; end if;
    if not exists (select 1 from public.studio_distributors where id = p_distributor_id and tenant_id = tenant_id_value and active = true) then raise exception 'Distribuidor inválido'; end if;
    insert into public.studio_sellers(tenant_id, distributor_id, name, email, phone) values (tenant_id_value, p_distributor_id, display_name_value, normalized_email, coalesce(p_phone, '')) returning id into party_id_value;
  end if;
  insert into public.studio_members(email, role, active, permissions, tenant_id, party_type, party_id, display_name)
  values (normalized_email, p_type, true, '{"dashboard":true,"blocks":true,"games":true,"integration":true}'::jsonb, tenant_id_value, p_type, party_id_value, display_name_value);
  return jsonb_build_object('id', party_id_value, 'email', normalized_email, 'type', p_type, 'name', display_name_value);
exception when unique_violation then
  raise exception 'El correo o la entidad ya existe dentro de este administrador';
end;
$$;

create or replace function public.studio_transfer_block(p_block_code text, p_to_type text, p_to_id uuid, p_notes text default '')
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  block_row public.studio_blocks;
  actor_role_value text := public.studio_actor_role();
  actor_email_value text := public.studio_actor_email();
  tenant_id_value uuid := public.studio_actor_tenant();
  destination_name text;
  source_name text;
  source_id uuid;
  source_type text;
begin
  select * into block_row from public.studio_blocks where code = p_block_code for update;
  if block_row.code is null then raise exception 'Bloque no encontrado'; end if;
  if not public.studio_can_access_tenant(block_row.tenant_id) then raise exception 'Bloque fuera del espacio del administrador'; end if;
  if p_to_type not in ('distributor', 'seller') then raise exception 'El destino debe ser distribuidor o vendedor'; end if;
  if p_to_type = 'distributor' then
    select name into destination_name from public.studio_distributors where id = p_to_id and tenant_id = block_row.tenant_id and active = true;
  else
    select name into destination_name from public.studio_sellers where id = p_to_id and tenant_id = block_row.tenant_id and active = true;
  end if;
  if destination_name is null then raise exception 'El destinatario no pertenece a este administrador'; end if;
  if actor_role_value in ('developer', 'admin') and p_to_type <> 'distributor' then raise exception 'El administrador entrega bloques primero al distribuidor'; end if;
  if actor_role_value = 'distributor' then
    if block_row.holder_type <> 'distributor' or block_row.holder_id is distinct from (select party_id from public.studio_members where lower(email) = actor_email_value) then raise exception 'El distribuidor no posee este bloque'; end if;
    if p_to_type <> 'seller' then raise exception 'El distribuidor solo puede transferir a vendedores'; end if;
  end if;
  source_type := coalesce(block_row.holder_type, 'inventory');
  source_id := block_row.holder_id;
  source_name := coalesce(nullif(block_row.holder_name, ''), 'Inventario del administrador');
  update public.studio_blocks
  set holder_type = p_to_type, holder_id = p_to_id, holder_name = destination_name,
      distributor = case when p_to_type = 'distributor' then destination_name else distributor end,
      status = 'Entregado', delivered_at = now(), notes = coalesce(p_notes, ''), updated_at = now()
  where code = p_block_code;
  insert into public.studio_block_transfers(tenant_id, block_code, from_type, from_id, from_name, to_type, to_id, to_name, notes, transferred_by)
  values (block_row.tenant_id, p_block_code, source_type, source_id, source_name, p_to_type, p_to_id, destination_name, coalesce(p_notes, ''), actor_email_value);
  return jsonb_build_object('block_code', p_block_code, 'to_type', p_to_type, 'to_id', p_to_id, 'to_name', destination_name);
end;
$$;

alter table public.studio_tenants enable row level security;
alter table public.studio_distributors enable row level security;
alter table public.studio_sellers enable row level security;
alter table public.studio_clients enable row level security;
alter table public.studio_block_transfers enable row level security;
alter table public.studio_sales enable row level security;

drop policy if exists studio_tenants_access on public.studio_tenants;
create policy studio_tenants_access on public.studio_tenants for select using (public.studio_can_access_tenant(id));
drop policy if exists studio_members_read on public.studio_members;
create policy studio_members_read on public.studio_members for select using (
  public.studio_actor_role() = 'developer'
  or lower(email) = public.studio_actor_email()
  or (tenant_id is not null and tenant_id = public.studio_actor_tenant())
);
drop policy if exists studio_distributors_access on public.studio_distributors;
create policy studio_distributors_access on public.studio_distributors for all using (public.studio_can_access_tenant(tenant_id)) with check (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_sellers_access on public.studio_sellers;
create policy studio_sellers_access on public.studio_sellers for all using (public.studio_can_access_tenant(tenant_id)) with check (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_clients_access on public.studio_clients;
create policy studio_clients_access on public.studio_clients for all using (public.studio_can_access_tenant(tenant_id)) with check (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_transfers_access on public.studio_block_transfers;
create policy studio_transfers_access on public.studio_block_transfers for select using (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_sales_access on public.studio_sales;
create policy studio_sales_access on public.studio_sales for all using (public.studio_can_access_tenant(tenant_id)) with check (public.studio_can_access_tenant(tenant_id));

drop policy if exists studio_audit_insert on public.studio_audit_events;
create policy studio_audit_insert on public.studio_audit_events for insert with check (
  public.studio_actor_role() is not null
  and lower(actor_email) = public.studio_actor_email()
  and (public.studio_actor_role() = 'developer' or tenant_id = public.studio_actor_tenant())
);
drop policy if exists studio_audit_read on public.studio_audit_events;
create policy studio_audit_read on public.studio_audit_events for select using (
  public.studio_can_access_tenant(tenant_id) and public.studio_can_access('audit')
);

drop policy if exists studio_campaigns_manage on public.studio_campaigns;
create policy studio_campaigns_manage on public.studio_campaigns for all using (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('generator')) with check (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('generator'));
drop policy if exists studio_blocks_manage on public.studio_blocks;
create policy studio_blocks_manage on public.studio_blocks for all using (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('blocks')) with check (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('blocks'));
drop policy if exists studio_patterns_manage on public.studio_patterns;
create policy studio_patterns_manage on public.studio_patterns for all using (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('patterns')) with check (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('patterns'));
drop policy if exists studio_games_manage on public.studio_games;
create policy studio_games_manage on public.studio_games for all using (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('games')) with check (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('games'));
drop policy if exists studio_generation_jobs_manage on public.studio_generation_jobs;
create policy studio_generation_jobs_manage on public.studio_generation_jobs for all using (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('generator')) with check (public.studio_can_access_tenant(tenant_id) and public.studio_can_access('generator'));

drop trigger if exists studio_tenants_updated_at on public.studio_tenants;
create trigger studio_tenants_updated_at before update on public.studio_tenants for each row execute function public.studio_touch_updated_at();
drop trigger if exists studio_distributors_updated_at on public.studio_distributors;
create trigger studio_distributors_updated_at before update on public.studio_distributors for each row execute function public.studio_touch_updated_at();
drop trigger if exists studio_sellers_updated_at on public.studio_sellers;
create trigger studio_sellers_updated_at before update on public.studio_sellers for each row execute function public.studio_touch_updated_at();
drop trigger if exists studio_clients_updated_at on public.studio_clients;
create trigger studio_clients_updated_at before update on public.studio_clients for each row execute function public.studio_touch_updated_at();

create index if not exists studio_members_tenant_idx on public.studio_members(tenant_id, role);
create index if not exists studio_blocks_tenant_idx on public.studio_blocks(tenant_id, status, updated_at desc);
create index if not exists studio_transfers_tenant_idx on public.studio_block_transfers(tenant_id, created_at desc);
create index if not exists studio_sales_tenant_idx on public.studio_sales(tenant_id, sold_at desc);
