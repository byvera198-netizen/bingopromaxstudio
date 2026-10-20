import { supabase } from './supabase'
import type { BingoBlock } from './bingo'

const SYNC_CHUNK_SIZE = 100

type StudioBlockRow = {
  code: string
  campaign_code: string
  range_text: string
  pages: number
  status: BingoBlock['status']
  distributor: string | null
  delivered_at: string | null
  notes: string
  payload: unknown
  created_by?: string | null
  tenant_id?: string | null
  holder_type?: 'admin' | 'distributor' | 'seller' | null
  holder_id?: string | null
  holder_name?: string | null
}

export type StudioTenant = { id: string; name: string; slug: string; ownerEmail: string; active: boolean }
export type StudioParty = { id: string; type: 'distributor' | 'seller'; name: string; email: string; phone: string; distributorId?: string; active: boolean }
export type StudioTransfer = { id: string; blockCode: string; fromType: string; fromName: string; toType: string; toName: string; notes: string; transferredBy: string; createdAt: string }
export type StudioClient = { id: string; name: string; email: string; phone: string }
export type StudioSale = { id: string; blockCode: string; sellerType: 'distributor' | 'seller'; sellerId: string; clientName: string; sheetsSold: number; cardsSold: number; amount: number; notes: string; soldAt: string }

export type StudioGame = {
  id: string
  name: string
  date: string
  prize: string
  status: 'ready' | 'running' | 'paused' | 'finished'
  activePatternIds: string[]
  drawnNumbers: number[]
  winnerHistory: Array<{ pattern: string; count: number; ball: number }>
  notes: string
}

export type StudioPattern = {
  id: string
  name: string
  description: string
  group: string
  color: string
  cells: number[]
  active: boolean
}

export type StudioMember = {
  email: string
  role: 'developer' | 'admin' | 'operator' | 'distributor' | 'seller'
  active: boolean
  permissions: Record<string, boolean>
  tenantId?: string
  partyId?: string
  partyType?: 'distributor' | 'seller'
  displayName?: string
}

export type StudioAuditEvent = {
  id: string
  action: string
  detail: string
  actor: string
  createdAt: string
}

export type StudioGenerationCheckpoint = {
  id: 'active'
  campaign: string
  totalSheets: number
  completedSheets: number
  nextPage: number
  nextBlockNumber: number
  updatedAt: string
}

function asBlock(value: unknown): BingoBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const block = value as Partial<BingoBlock>
  if (!block.code || !block.campaign || !Array.isArray(block.sheets)) return null
  return block as BingoBlock
}

async function currentUserId() {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

function blockRow(block: BingoBlock, userId: string, tenantId?: string | null): StudioBlockRow {
  return {
    code: block.code,
    campaign_code: block.campaign,
    range_text: block.range,
    pages: block.pages,
    status: block.status,
    distributor: block.distributor ?? null,
    delivered_at: block.deliveredAt ?? null,
    notes: block.notes ?? '',
    payload: block,
    created_by: userId,
    tenant_id: tenantId ?? undefined,
  }
}

export async function loadStudioBlocks(tenantId?: string | null): Promise<BingoBlock[]> {
  const userId = await currentUserId()
  if (!userId) return []
  let query = supabase
    .from('studio_blocks')
    .select('code,campaign_code,range_text,pages,status,distributor,delivered_at,notes,payload,created_by,holder_type,holder_id,holder_name')
    .order('created_at', { ascending: true })
  if (tenantId) query = query.eq('tenant_id', tenantId)
  const { data, error } = await query
  if (error) throw error
  const mapped: Array<BingoBlock | null> = (data as StudioBlockRow[] | null ?? []).map((row) => {
    const block = asBlock(row.payload)
    if (!block) return null
    return { ...block, status: row.status, distributor: row.distributor ?? undefined, deliveredAt: row.delivered_at ?? undefined, notes: row.notes, holderType: row.holder_type ?? undefined, holderId: row.holder_id ?? undefined, holderName: row.holder_name ?? undefined }
  })
  return mapped.filter((block): block is BingoBlock => Boolean(block))
}

export async function syncStudioInventory(blocks: BingoBlock[], tenantId?: string | null) {
  const userId = await currentUserId()
  if (!userId || !blocks.length) return
  const campaigns = Array.from(new Map(blocks.map((block) => [block.campaign, block])).values()).map((block) => ({
    code: block.campaign,
    name: block.campaign,
    created_by: userId,
    tenant_id: tenantId ?? undefined,
    updated_at: new Date().toISOString(),
  }))
  const campaignResult = await supabase.from('studio_campaigns').upsert(campaigns, { onConflict: 'code' })
  if (campaignResult.error) throw campaignResult.error
  for (let offset = 0; offset < blocks.length; offset += SYNC_CHUNK_SIZE) {
    const rows = blocks.slice(offset, offset + SYNC_CHUNK_SIZE).map((block) => blockRow(block, userId, tenantId))
    const result = await supabase.from('studio_blocks').upsert(rows, { onConflict: 'code' })
    if (result.error) throw result.error
  }
}

export async function syncStudioBlock(block: BingoBlock, tenantId?: string | null) {
  const userId = await currentUserId()
  if (!userId) return
  const campaignResult = await supabase.from('studio_campaigns').upsert({
    code: block.campaign,
    name: block.campaign,
    created_by: userId,
    tenant_id: tenantId ?? undefined,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'code' })
  if (campaignResult.error) throw campaignResult.error
  const result = await supabase.from('studio_blocks').upsert(blockRow(block, userId, tenantId), { onConflict: 'code' })
  if (result.error) throw result.error
}

export async function loadStudioGenerationCheckpoint(tenantId?: string | null): Promise<StudioGenerationCheckpoint | null> {
  const userId = await currentUserId()
  if (!userId) return null
  let query = supabase
    .from('studio_generation_jobs')
    .select('campaign_code,total_sheets,completed_sheets,next_page,next_block_number,status,updated_at')
    .eq('created_by', userId)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
  if (tenantId) query = query.eq('tenant_id', tenantId)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    id: 'active',
    campaign: String(data.campaign_code),
    totalSheets: Number(data.total_sheets),
    completedSheets: Number(data.completed_sheets),
    nextPage: Number(data.next_page),
    nextBlockNumber: Number(data.next_block_number),
    updatedAt: String(data.updated_at),
  }
}

export async function saveStudioGenerationCheckpoint(checkpoint: StudioGenerationCheckpoint, tenantId?: string | null) {
  const userId = await currentUserId()
  if (!userId) return
  const result = await supabase.from('studio_generation_jobs').upsert({
    campaign_code: checkpoint.campaign,
    total_sheets: checkpoint.totalSheets,
    completed_sheets: checkpoint.completedSheets,
    next_page: checkpoint.nextPage,
    next_block_number: checkpoint.nextBlockNumber,
    status: 'active',
    created_by: userId,
    updated_at: checkpoint.updatedAt,
    tenant_id: tenantId ?? undefined,
  }, { onConflict: 'campaign_code,created_by' })
  if (result.error) throw result.error
}

export async function clearStudioGenerationCheckpoint(campaign: string, tenantId?: string | null) {
  const userId = await currentUserId()
  if (!userId) return
  let query = supabase
    .from('studio_generation_jobs')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('campaign_code', campaign)
    .eq('created_by', userId)
    .eq('status', 'active')
  if (tenantId) query = query.eq('tenant_id', tenantId)
  const result = await query
  if (result.error) throw result.error
}

export async function writeStudioAudit(action: string, detail: string) {
  const user = await supabase.auth.getUser()
  if (user.error || !user.data.user?.email) return
  const actorEmail = user.data.user.email.toLowerCase()
  const memberResult = await supabase.from('studio_members').select('tenant_id').eq('email', actorEmail).maybeSingle()
  if (memberResult.error) throw memberResult.error
  const result = await supabase.from('studio_audit_events').insert({
    action,
    detail,
    actor_email: actorEmail,
    tenant_id: (memberResult.data as { tenant_id?: string | null } | null)?.tenant_id ?? null,
  })
  if (result.error) throw result.error
}

export async function loadStudioAuditEvents(): Promise<StudioAuditEvent[]> {
  const userId = await currentUserId()
  if (!userId) return []
  const { data, error } = await supabase
    .from('studio_audit_events')
    .select('id,action,detail,actor_email,created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return (data as Array<Record<string, unknown>> | null ?? []).flatMap((row) => {
    const id = String(row.id ?? '')
    const action = String(row.action ?? '')
    if (!id || !action) return []
    return [{
      id,
      action,
      detail: String(row.detail ?? ''),
      actor: String(row.actor_email ?? 'Sistema'),
      createdAt: String(row.created_at ?? new Date().toISOString()),
    }]
  })
}

function mapGame(row: Record<string, unknown>): StudioGame {
  const patterns = Array.isArray(row.active_pattern_ids) ? row.active_pattern_ids : []
  const draws = Array.isArray(row.drawn_numbers) ? row.drawn_numbers : []
  const winners = Array.isArray(row.winner_history) ? row.winner_history : []
  return {
    id: String(row.id),
    name: String(row.name ?? 'Partida Studio'),
    date: String(row.game_date ?? ''),
    prize: String(row.prize ?? ''),
    status: (['ready', 'running', 'paused', 'finished'].includes(String(row.status)) ? String(row.status) : 'ready') as StudioGame['status'],
    activePatternIds: patterns.filter((value): value is string => typeof value === 'string'),
    drawnNumbers: draws.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 75),
    winnerHistory: winners.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const item = value as Record<string, unknown>
      const pattern = String(item.pattern ?? '')
      const count = Number(item.count)
      const ball = Number(item.ball)
      return pattern && Number.isInteger(count) && count >= 0 && Number.isInteger(ball) && ball >= 1 && ball <= 75 ? [{ pattern, count, ball }] : []
    }),
    notes: String(row.notes ?? ''),
  }
}

export async function loadStudioGame(): Promise<StudioGame | null> {
  const userId = await currentUserId()
  if (!userId) return null
  const { data, error } = await supabase
    .from('studio_games')
    .select('id,name,game_date,prize,status,active_pattern_ids,drawn_numbers,winner_history,notes')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? mapGame(data as Record<string, unknown>) : null
}

export async function syncStudioGame(game: StudioGame) {
  const userId = await currentUserId()
  if (!userId) return
  const result = await supabase.from('studio_games').upsert({
    id: game.id,
    name: game.name,
    game_date: game.date || null,
    prize: game.prize,
    status: game.status,
    active_pattern_ids: game.activePatternIds,
    drawn_numbers: game.drawnNumbers,
    winner_history: game.winnerHistory,
    notes: game.notes,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' })
  if (result.error) throw result.error
}

function mapPattern(row: Record<string, unknown>): StudioPattern | null {
  const cells = Array.isArray(row.cells) ? row.cells.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 25) : []
  const id = String(row.id ?? '')
  const name = String(row.name ?? '')
  if (!id || !name || !cells.length) return null
  return {
    id,
    name,
    description: String(row.description ?? ''),
    group: String(row.pattern_group ?? 'Personalizados'),
    color: String(row.color ?? '#f5c84b'),
    cells: Array.from(new Set(cells)),
    active: row.active === true,
  }
}

export async function loadStudioPatterns(): Promise<StudioPattern[]> {
  const userId = await currentUserId()
  if (!userId) return []
  const { data, error } = await supabase
    .from('studio_patterns')
    .select('id,name,description,pattern_group,color,cells,active')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data as Array<Record<string, unknown>> | null ?? []).map(mapPattern).filter((pattern): pattern is StudioPattern => Boolean(pattern))
}

export async function syncStudioPatterns(patterns: StudioPattern[]) {
  const userId = await currentUserId()
  if (!userId || !patterns.length) return
  const rows = patterns.map((pattern) => ({
    id: pattern.id,
    name: pattern.name,
    description: pattern.description,
    pattern_group: pattern.group,
    color: pattern.color,
    cells: pattern.cells,
    active: pattern.active,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }))
  for (let offset = 0; offset < rows.length; offset += SYNC_CHUNK_SIZE) {
    const result = await supabase.from('studio_patterns').upsert(rows.slice(offset, offset + SYNC_CHUNK_SIZE), { onConflict: 'id' })
    if (result.error) throw result.error
  }
}

function mapMember(row: Record<string, unknown>): StudioMember | null {
  const email = String(row.email ?? '').trim().toLowerCase()
  const role = String(row.role ?? '')
  if (!email || !['developer', 'admin', 'operator', 'distributor', 'seller'].includes(role)) return null
  const permissions = row.permissions && typeof row.permissions === 'object' && !Array.isArray(row.permissions)
    ? Object.fromEntries(Object.entries(row.permissions as Record<string, unknown>).map(([key, value]) => [key, value === true]))
    : {}
  return {
    email,
    role: role as StudioMember['role'],
    active: row.active !== false,
    permissions,
    tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : undefined,
    partyId: typeof row.party_id === 'string' ? row.party_id : undefined,
    partyType: row.party_type === 'distributor' || row.party_type === 'seller' ? row.party_type : undefined,
    displayName: typeof row.display_name === 'string' ? row.display_name : undefined,
  }
}

export async function loadStudioMember(email: string): Promise<StudioMember | null> {
  const { data, error } = await supabase
    .from('studio_members')
    .select('email,role,active,permissions,tenant_id,party_id,party_type,display_name')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle()
  if (error) throw error
  return data ? mapMember(data as Record<string, unknown>) : null
}

export async function loadStudioMembers(): Promise<StudioMember[]> {
  const userId = await currentUserId()
  if (!userId) return []
  const { data, error } = await supabase
    .from('studio_members')
    .select('email,role,active,permissions,tenant_id,party_id,party_type,display_name')
    .order('email', { ascending: true })
  if (error) throw error
  return (data as Array<Record<string, unknown>> | null ?? []).map(mapMember).filter((member): member is StudioMember => Boolean(member))
}

export async function saveStudioMember(member: StudioMember) {
  const userId = await currentUserId()
  if (!userId) return
  const result = await supabase.from('studio_members').upsert({
    email: member.email.trim().toLowerCase(),
    role: member.role,
    active: member.active,
    permissions: member.permissions,
    tenant_id: member.tenantId ?? null,
    party_id: member.partyId ?? null,
    party_type: member.partyType ?? null,
    display_name: member.displayName ?? '',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'email' })
  if (result.error) throw result.error
}

function mapTenant(row: Record<string, unknown>): StudioTenant {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Operación'),
    slug: String(row.slug ?? ''),
    ownerEmail: String(row.owner_email ?? ''),
    active: row.active !== false,
  }
}

export async function loadStudioTenants(): Promise<StudioTenant[]> {
  const userId = await currentUserId()
  if (!userId) return []
  const { data, error } = await supabase.from('studio_tenants').select('id,name,slug,owner_email,active').eq('active', true).order('name')
  if (error) throw error
  return (data as Array<Record<string, unknown>> | null ?? []).map(mapTenant).filter((tenant) => tenant.id)
}

export async function createStudioAdmin(email: string, name: string, tenantName: string) {
  const { data, error } = await supabase.rpc('studio_create_admin', { p_email: email, p_name: name, p_tenant_name: tenantName })
  if (error) throw error
  return data as { tenant_id: string; email: string; role: 'admin'; name: string }
}

export async function createStudioPartyAccount(type: 'distributor' | 'seller', name: string, email: string, phone: string, distributorId?: string, tenantId?: string) {
  const { data, error } = await supabase.rpc('studio_create_party_account', { p_type: type, p_name: name, p_email: email, p_phone: phone, p_distributor_id: distributorId ?? null, p_tenant_id: tenantId ?? null })
  if (error) throw error
  return data as { id: string; email: string; type: 'distributor' | 'seller'; name: string }
}

export async function loadStudioNetwork(tenantId: string) {
  const [distributorsResult, sellersResult, clientsResult, transfersResult, salesResult] = await Promise.all([
    supabase.from('studio_distributors').select('id,name,email,phone,active').eq('tenant_id', tenantId).eq('active', true).order('name'),
    supabase.from('studio_sellers').select('id,distributor_id,name,email,phone,active').eq('tenant_id', tenantId).eq('active', true).order('name'),
    supabase.from('studio_clients').select('id,name,email,phone').eq('tenant_id', tenantId).order('name'),
    supabase.from('studio_block_transfers').select('id,block_code,from_type,from_name,to_type,to_name,notes,transferred_by,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(300),
    supabase.from('studio_sales').select('id,block_code,seller_type,seller_id,client_id,sheets_sold,cards_sold,amount,notes,sold_at,studio_clients(name)').eq('tenant_id', tenantId).order('sold_at', { ascending: false }).limit(500),
  ])
  if (distributorsResult.error) throw distributorsResult.error
  if (sellersResult.error) throw sellersResult.error
  if (clientsResult.error) throw clientsResult.error
  if (transfersResult.error) throw transfersResult.error
  if (salesResult.error) throw salesResult.error
  return {
    distributors: (distributorsResult.data as Array<Record<string, unknown>> ?? []).map((row) => ({ id: String(row.id), type: 'distributor' as const, name: String(row.name), email: String(row.email), phone: String(row.phone ?? ''), active: row.active !== false })),
    sellers: (sellersResult.data as Array<Record<string, unknown>> ?? []).map((row) => ({ id: String(row.id), type: 'seller' as const, name: String(row.name), email: String(row.email), phone: String(row.phone ?? ''), distributorId: String(row.distributor_id), active: row.active !== false })),
    clients: (clientsResult.data as Array<Record<string, unknown>> ?? []).map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email ?? ''), phone: String(row.phone ?? '') })),
    transfers: (transfersResult.data as Array<Record<string, unknown>> ?? []).map((row) => ({ id: String(row.id), blockCode: String(row.block_code), fromType: String(row.from_type), fromName: String(row.from_name ?? ''), toType: String(row.to_type), toName: String(row.to_name ?? ''), notes: String(row.notes ?? ''), transferredBy: String(row.transferred_by ?? ''), createdAt: String(row.created_at) })),
    sales: (salesResult.data as Array<Record<string, unknown>> ?? []).map((row) => {
      const client = row.studio_clients && typeof row.studio_clients === 'object' && !Array.isArray(row.studio_clients) ? row.studio_clients as Record<string, unknown> : {}
      return { id: String(row.id), blockCode: String(row.block_code), sellerType: row.seller_type === 'seller' ? 'seller' as const : 'distributor' as const, sellerId: String(row.seller_id), clientName: String(client.name ?? 'Cliente general'), sheetsSold: Number(row.sheets_sold ?? 0), cardsSold: Number(row.cards_sold ?? 0), amount: Number(row.amount ?? 0), notes: String(row.notes ?? ''), soldAt: String(row.sold_at) }
    }),
  }
}

export async function transferStudioBlock(blockCode: string, toType: 'distributor' | 'seller', toId: string, notes = '') {
  const { data, error } = await supabase.rpc('studio_transfer_block', { p_block_code: blockCode, p_to_type: toType, p_to_id: toId, p_notes: notes })
  if (error) throw error
  return data as { block_code: string; to_type: string; to_id: string; to_name: string }
}

export async function createStudioClient(name: string, email: string, phone: string, tenantId?: string) {
  const { data, error } = await supabase.rpc('studio_create_client', { p_name: name, p_email: email, p_phone: phone, p_tenant_id: tenantId ?? null })
  if (error) throw error
  return data as { id: string; name: string; email: string; phone: string }
}

export async function recordStudioSale(input: { blockCode: string; sellerType: 'distributor' | 'seller'; sellerId: string; clientId: string; sheetsSold: number; cardsSold: number; amount: number; notes?: string }) {
  const { data, error } = await supabase.rpc('studio_record_sale', {
    p_block_code: input.blockCode,
    p_seller_type: input.sellerType,
    p_seller_id: input.sellerId,
    p_client_id: input.clientId,
    p_sheets_sold: input.sheetsSold,
    p_cards_sold: input.cardsSold,
    p_amount: input.amount,
    p_notes: input.notes ?? '',
  })
  if (error) throw error
  return data as { id: string; block_code: string; sheets_sold: number; cards_sold: number; amount: number }
}
