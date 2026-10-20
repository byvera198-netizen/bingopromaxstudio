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
