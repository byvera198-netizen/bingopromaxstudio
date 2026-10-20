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
