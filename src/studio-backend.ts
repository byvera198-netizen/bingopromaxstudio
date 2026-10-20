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
}

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
  role: 'developer' | 'admin' | 'operator'
  active: boolean
  permissions: Record<string, boolean>
}

export type StudioAuditEvent = {
  id: string
  action: string
  detail: string
  actor: string
  createdAt: string
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

function blockRow(block: BingoBlock, userId: string): StudioBlockRow {
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
  }
}

export async function loadStudioBlocks(): Promise<BingoBlock[]> {
  const userId = await currentUserId()
  if (!userId) return []
  const { data, error } = await supabase
    .from('studio_blocks')
    .select('code,campaign_code,range_text,pages,status,distributor,delivered_at,notes,payload,created_by')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data as StudioBlockRow[] | null ?? []).map((row) => asBlock(row.payload)).filter((block): block is BingoBlock => Boolean(block))
}

export async function syncStudioInventory(blocks: BingoBlock[]) {
  const userId = await currentUserId()
  if (!userId || !blocks.length) return
  const campaigns = Array.from(new Map(blocks.map((block) => [block.campaign, block])).values()).map((block) => ({
    code: block.campaign,
    name: block.campaign,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }))
  const campaignResult = await supabase.from('studio_campaigns').upsert(campaigns, { onConflict: 'code' })
  if (campaignResult.error) throw campaignResult.error
  for (let offset = 0; offset < blocks.length; offset += SYNC_CHUNK_SIZE) {
    const rows = blocks.slice(offset, offset + SYNC_CHUNK_SIZE).map((block) => blockRow(block, userId))
    const result = await supabase.from('studio_blocks').upsert(rows, { onConflict: 'code' })
    if (result.error) throw result.error
  }
}

export async function syncStudioBlock(block: BingoBlock) {
  const userId = await currentUserId()
  if (!userId) return
  const campaignResult = await supabase.from('studio_campaigns').upsert({
    code: block.campaign,
    name: block.campaign,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'code' })
  if (campaignResult.error) throw campaignResult.error
  const result = await supabase.from('studio_blocks').upsert(blockRow(block, userId), { onConflict: 'code' })
  if (result.error) throw result.error
}

export async function writeStudioAudit(action: string, detail: string) {
  const user = await supabase.auth.getUser()
  if (user.error || !user.data.user?.email) return
  const result = await supabase.from('studio_audit_events').insert({
    action,
    detail,
    actor_email: user.data.user.email.toLowerCase(),
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
  if (!email || !['developer', 'admin', 'operator'].includes(role)) return null
  const permissions = row.permissions && typeof row.permissions === 'object' && !Array.isArray(row.permissions)
    ? Object.fromEntries(Object.entries(row.permissions as Record<string, unknown>).map(([key, value]) => [key, value === true]))
    : {}
  return { email, role: role as StudioMember['role'], active: row.active !== false, permissions }
}

export async function loadStudioMember(email: string): Promise<StudioMember | null> {
  const { data, error } = await supabase
    .from('studio_members')
    .select('email,role,active,permissions')
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
    .select('email,role,active,permissions')
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
    updated_at: new Date().toISOString(),
  }, { onConflict: 'email' })
  if (result.error) throw result.error
}
