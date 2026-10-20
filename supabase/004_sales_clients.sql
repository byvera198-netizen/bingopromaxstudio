-- Bingo ProMax Studio: clientes y ventas con control de tenencia.
-- Ejecutar después de 003_multi_tenant_distribution.sql.

create or replace function public.studio_create_client(p_name text, p_email text default '', p_phone text default '', p_tenant_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public
as $studio$
declare
  actor_role_value text := public.studio_actor_role();
  tenant_id_value uuid := coalesce(p_tenant_id, public.studio_actor_tenant());
  client_row public.studio_clients;
  client_name_value text := nullif(trim(p_name), '');
begin
  if actor_role_value not in ('developer', 'admin', 'distributor', 'seller') then
    raise exception 'No tienes permisos para registrar clientes';
  end if;
  if client_name_value is null then raise exception 'El nombre del cliente es obligatorio'; end if;
  if tenant_id_value is null or not public.studio_can_access_tenant(tenant_id_value) then
    raise exception 'Espacio de administrador inválido';
  end if;
  if actor_role_value in ('distributor', 'seller') and tenant_id_value is distinct from public.studio_actor_tenant() then
    raise exception 'No puedes registrar clientes fuera de tu espacio';
  end if;
  insert into public.studio_clients(tenant_id, name, email, phone)
  values (tenant_id_value, client_name_value, lower(trim(coalesce(p_email, ''))), trim(coalesce(p_phone, '')))
  returning * into client_row;
  return jsonb_build_object('id', client_row.id, 'name', client_row.name, 'email', client_row.email, 'phone', client_row.phone);
end;
$studio$;

create or replace function public.studio_record_sale(
  p_block_code text,
  p_seller_type text,
  p_seller_id uuid,
  p_client_id uuid,
  p_sheets_sold integer,
  p_cards_sold integer,
  p_amount numeric default 0,
  p_notes text default ''
)
returns jsonb language plpgsql security definer set search_path = public
as $studio$
declare
  actor_role_value text := public.studio_actor_role();
  actor_email_value text := public.studio_actor_email();
  block_row public.studio_blocks;
  client_row public.studio_clients;
  seller_exists boolean := false;
  seller_tenant uuid;
  sold_sheets integer := 0;
  sold_cards integer := 0;
  sale_row public.studio_sales;
begin
  if actor_role_value not in ('developer', 'admin', 'distributor', 'seller') then
    raise exception 'No tienes permisos para registrar ventas';
  end if;
  if p_seller_type not in ('distributor', 'seller') then raise exception 'Vendedor inválido'; end if;
  if p_seller_id is null then raise exception 'Selecciona el vendedor'; end if;
  if p_sheets_sold is null or p_sheets_sold <= 0 then raise exception 'Las hojas vendidas deben ser mayores que cero'; end if;
  if p_cards_sold is null or p_cards_sold <= 0 then raise exception 'Los cartones vendidos deben ser mayores que cero'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'El importe no puede ser negativo'; end if;
  select * into block_row from public.studio_blocks where code = trim(p_block_code) for update;
  if block_row.code is null then raise exception 'Bloque no encontrado'; end if;
  if not public.studio_can_access_tenant(block_row.tenant_id) then raise exception 'Bloque fuera del espacio del administrador'; end if;
  select exists (
    select 1 from public.studio_distributors where id = p_seller_id and tenant_id = block_row.tenant_id and active = true
  ) into seller_exists;
  if p_seller_type = 'seller' then
    select exists (
      select 1 from public.studio_sellers where id = p_seller_id and tenant_id = block_row.tenant_id and active = true
    ) into seller_exists;
  end if;
  if not seller_exists then raise exception 'El vendedor no pertenece a este administrador'; end if;
  select tenant_id into seller_tenant from public.studio_distributors where id = p_seller_id;
  if p_seller_type = 'seller' then select tenant_id into seller_tenant from public.studio_sellers where id = p_seller_id; end if;
  if seller_tenant is distinct from block_row.tenant_id then raise exception 'El vendedor no pertenece al bloque'; end if;
  if actor_role_value in ('distributor', 'seller') then
    if not exists (select 1 from public.studio_members where lower(email) = actor_email_value and party_type = p_seller_type and party_id = p_seller_id and active = true) then
      raise exception 'Solo puedes registrar ventas de tu propia cuenta';
    end if;
  end if;
  if block_row.holder_type is distinct from p_seller_type or block_row.holder_id is distinct from p_seller_id then
    raise exception 'El vendedor no posee este bloque';
  end if;
  select * into client_row from public.studio_clients where id = p_client_id and tenant_id = block_row.tenant_id;
  if client_row.id is null then raise exception 'Cliente inválido'; end if;
  select coalesce(sum(sheets_sold), 0), coalesce(sum(cards_sold), 0)
    into sold_sheets, sold_cards
    from public.studio_sales
   where block_code = block_row.code;
  if sold_sheets + p_sheets_sold > block_row.pages then raise exception 'La venta supera las hojas disponibles del bloque'; end if;
  if sold_cards + p_cards_sold > block_row.pages * 4 then raise exception 'La venta supera los cartones disponibles del bloque'; end if;
  insert into public.studio_sales(tenant_id, block_code, seller_type, seller_id, client_id, sheets_sold, cards_sold, amount, notes, created_by)
  values (block_row.tenant_id, block_row.code, p_seller_type, p_seller_id, client_row.id, p_sheets_sold, p_cards_sold, p_amount, coalesce(p_notes, ''), auth.uid())
  returning * into sale_row;
  return jsonb_build_object('id', sale_row.id, 'block_code', sale_row.block_code, 'sheets_sold', sale_row.sheets_sold, 'cards_sold', sale_row.cards_sold, 'amount', sale_row.amount);
end;
$studio$;

grant execute on function public.studio_create_client(text, text, text, uuid) to authenticated;
grant execute on function public.studio_record_sale(text, text, uuid, uuid, integer, integer, numeric, text) to authenticated;

drop policy if exists studio_clients_access on public.studio_clients;
create policy studio_clients_read on public.studio_clients for select using (public.studio_can_access_tenant(tenant_id));
drop policy if exists studio_sales_access on public.studio_sales;
create policy studio_sales_read on public.studio_sales for select using (public.studio_can_access_tenant(tenant_id));

create index if not exists studio_clients_tenant_name_idx on public.studio_clients(tenant_id, name);
create index if not exists studio_sales_block_idx on public.studio_sales(block_code, sold_at desc);
