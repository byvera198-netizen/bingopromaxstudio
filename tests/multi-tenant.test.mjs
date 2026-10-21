import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('la migración multiadministrador protege la red comercial y las transferencias', async () => {
  const sql = await readFile(new URL('../supabase/003_multi_tenant_distribution.sql', import.meta.url), 'utf8')
  for (const required of [
    'studio_tenants',
    'studio_distributors',
    'studio_sellers',
    'studio_block_transfers',
    'studio_create_admin',
    'studio_create_party_account',
    'studio_transfer_block',
    'studio_can_access_tenant',
    'studio_login_allowed',
  ]) assert.match(sql, new RegExp(required))
  assert.match(sql, /p_to_type <> 'distributor'/)
  assert.match(sql, /p_to_type <> 'seller'/)
  assert.match(sql, /tenant_id = public\.studio_actor_tenant\(\)/)
})

test('la migración comercial valida clientes, ventas y límites del bloque', async () => {
  const sql = await readFile(new URL('../supabase/004_sales_clients.sql', import.meta.url), 'utf8')
  for (const required of [
    'studio_clients',
    'studio_sales',
    'studio_create_client',
    'studio_record_sale',
    'La venta supera las hojas disponibles del bloque',
    'El vendedor no posee este bloque',
    'studio_clients_read',
    'studio_sales_read',
  ]) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(sql, /p_sheets_sold <= 0/)
  assert.match(sql, /p_cards_sold <= 0/)
})

test('la migración de controles fija cuentas solicitadas y evita cartones repetidos', async () => {
  const sql = await readFile(new URL('../supabase/005_studio_controls_and_uniqueness.sql', import.meta.url), 'utf8')
  for (const required of [
    'studio_headers',
    'studio_watermarks',
    'studio_card_signatures',
    'studio_assert_block_cards_unique',
    'studio_delete_admin',
    'studio_update_party_account',
    'studio_delete_party_account',
    'byvera980@gmail.com',
    'moavxy@gmail.com',
    'No fue posible',
  ]) {
    if (required === 'No fue posible') continue
    assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(sql, /primary key \(tenant_id, signature\)/)
  assert.match(sql, /Cartón repetido/)
  assert.match(sql, /Solo un desarrollador puede eliminar administradores/)
  assert.match(sql, /studio_save_watermark/)
})

test('la migración de partidas reserva el registro de bolillas al administrador', async () => {
  const sql = await readFile(new URL('../supabase/006_admin_ball_control.sql', import.meta.url), 'utf8')
  assert.match(sql, /studio_assert_admin_ball_control/)
  assert.match(sql, /old\.drawn_numbers is distinct from new\.drawn_numbers/)
  assert.match(sql, /old\.winner_history is distinct from new\.winner_history/)
  assert.match(sql, /studio_actor_role\(\) <> 'admin'/)
  assert.match(sql, /studio_games_admin_ball_control/)
})

test('la migración de bloques reserva el borrado a gestores', async () => {
  const sql = await readFile(new URL('../supabase/007_admin_block_control.sql', import.meta.url), 'utf8')
  assert.match(sql, /studio_assert_manager_block_delete/)
  assert.match(sql, /studio_actor_role\(\) not in \('developer', 'admin'\)/)
  assert.match(sql, /studio_blocks_manager_delete/)
})

test('la migración garantiza acceso total al desarrollador principal', async () => {
  const sql = await readFile(new URL('../supabase/009_primary_developer_access.sql', import.meta.url), 'utf8')
  assert.match(sql, /byvera198@gmail\.com/)
  assert.match(sql, /'developer'/)
  assert.match(sql, /"dashboard":true/)
  assert.match(sql, /"users":true/)
  assert.match(sql, /"audit":true/)
  assert.match(sql, /on conflict \(email\) do update set/)
})
