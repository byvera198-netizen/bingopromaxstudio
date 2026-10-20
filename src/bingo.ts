import { jsPDF } from 'jspdf'
import JSZip from 'jszip'

export const MAX_SHEETS = 200_000
export const SHEETS_PER_BLOCK = 40
export const CARDS_PER_SHEET = 4

export type BingoCard = {
  id: string
  numbers: number[][]
}

export type BingoSheet = {
  code: string
  blockCode: string
  pageNumber: number
  cards: BingoCard[]
}

export type BingoBlock = {
  code: string
  campaign: string
  range: string
  pages: number
  status: 'Listo' | 'Descargado' | 'Entregado'
  createdAt: string
  sheets: BingoSheet[]
}

const columnRanges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]] as const

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function cardSignature(numbers: number[][]): string {
  return numbers.flat().join('-')
}

function createCard(id: string, random: () => number): BingoCard {
  const columns = columnRanges.map(([from, to]) => {
    const pool = Array.from({ length: to - from + 1 }, (_, index) => from + index)
    return shuffle(pool, random).slice(0, 5).sort((a, b) => a - b)
  })
  const numbers = Array.from({ length: 5 }, (_, row) => columns.map((column, col) => row === 2 && col === 2 ? 0 : column[row]))
  return { id, numbers }
}

export function generateBatch(campaign: string, totalSheets: number, startingPage = 1): BingoBlock[] {
  if (!Number.isInteger(totalSheets) || totalSheets < 100 || totalSheets > MAX_SHEETS) throw new Error(`La cantidad debe estar entre 100 y ${MAX_SHEETS.toLocaleString('es-EC')} hojas.`)
  const random = Math.random
  const blocks: BingoBlock[] = []
  const usedCards = new Set<string>()
  const batchCode = campaign.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'BPS-2026'
  let page = startingPage
  for (let offset = 0; offset < totalSheets; offset += SHEETS_PER_BLOCK) {
    const blockSheets: BingoSheet[] = []
    const pageCount = Math.min(SHEETS_PER_BLOCK, totalSheets - offset)
    const blockNumber = Math.floor(offset / SHEETS_PER_BLOCK) + 1
    const blockCode = `${batchCode}-${String(blockNumber).padStart(3, '0')}`
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageNumber = page
      const sheets: BingoCard[] = []
      for (let cardIndex = 0; cardIndex < CARDS_PER_SHEET; cardIndex += 1) {
        let card = createCard(`${blockCode}-H${String(pageNumber).padStart(6, '0')}-C${cardIndex + 1}`, random)
        let signature = cardSignature(card.numbers)
        let attempts = 0
        while (usedCards.has(signature) && attempts < 12) {
          card = createCard(card.id, random)
          signature = cardSignature(card.numbers)
          attempts += 1
        }
        usedCards.add(signature)
        sheets.push(card)
      }
      blockSheets.push({ code: `${blockCode}-H${String(pageNumber).padStart(6, '0')}`, blockCode, pageNumber, cards: sheets })
      page += 1
    }
    blocks.push({ code: blockCode, campaign: batchCode, range: `${String(blockSheets[0].pageNumber).padStart(6, '0')} — ${String(blockSheets.at(-1)!.pageNumber).padStart(6, '0')}`, pages: pageCount, status: 'Listo', createdAt: new Date().toISOString(), sheets: blockSheets })
  }
  return blocks
}

function addCard(doc: jsPDF, card: BingoCard, x: number, y: number, width: number, height: number) {
  const cell = Math.min(width / 5, height / 6.3)
  const gridWidth = cell * 5
  const gridHeight = cell * 6
  const startX = x + (width - gridWidth) / 2
  doc.setDrawColor(45, 52, 49)
  doc.setFillColor(252, 250, 243)
  doc.roundedRect(startX, y, gridWidth, gridHeight, 2, 2, 'FD')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(Math.max(6, cell * 1.8))
  ;['B', 'I', 'N', 'G', 'O'].forEach((letter, col) => {
    doc.setTextColor(123, 91, 8)
    doc.text(letter, startX + col * cell + cell / 2, y + cell * .7, { align: 'center' })
  })
  doc.setFont('courier', 'bold')
  doc.setFontSize(Math.max(5, cell * 1.35))
  card.numbers.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
    const cx = startX + colIndex * cell
    const cy = y + (rowIndex + 1) * cell
    doc.setFillColor(value === 0 ? 209 : 247, value === 0 ? 181 : 246, value === 0 ? 70 : 231)
    doc.rect(cx, cy, cell, cell, 'FD')
    doc.setTextColor(value === 0 ? 40 : 28, value === 0 ? 31 : 35, value === 0 ? 14 : 32)
    doc.text(value === 0 ? '★' : String(value), cx + cell / 2, cy + cell * .66, { align: 'center' })
  }))
  doc.setTextColor(70, 77, 72)
  doc.setFont('courier', 'normal')
  doc.setFontSize(Math.max(5, cell * .85))
  doc.text(card.id, startX + gridWidth / 2, y + gridHeight + cell * .55, { align: 'center' })
}

export function createBlockPdf(block: BingoBlock): ArrayBuffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  block.sheets.forEach((sheet, index) => {
    if (index > 0) doc.addPage()
    doc.setFillColor(13, 17, 17)
    doc.rect(0, 0, 210, 22, 'F')
    doc.setTextColor(245, 200, 75)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.text('BINGO PROMAX STUDIO', 14, 12)
    doc.setTextColor(180, 188, 180)
    doc.setFont('courier', 'normal')
    doc.setFontSize(7)
    doc.text(`HOJA ${sheet.code}`, 196, 10, { align: 'right' })
    doc.text(`BLOQUE ${block.code}`, 196, 16, { align: 'right' })
    doc.setTextColor(50, 58, 52)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.text('Cartones de bingo · 5 × 5 · centro libre · 75 bolillas', 14, 30)
    const positions = [[14, 39], [108, 39], [14, 139], [108, 139]] as const
    sheet.cards.forEach((card, cardIndex) => addCard(doc, card, positions[cardIndex][0], positions[cardIndex][1], 88, 82))
    doc.setDrawColor(220, 218, 207)
    doc.line(14, 279, 196, 279)
    doc.setTextColor(95, 102, 96)
    doc.setFontSize(7)
    doc.text('Conserve esta hoja para validación y distribución.', 14, 286)
    doc.text(`${block.campaign} · ${index + 1}/${block.pages}`, 196, 286, { align: 'right' })
  })
  return doc.output('arraybuffer')
}

export async function createBlocksZip(blocks: BingoBlock[]): Promise<Blob> {
  const zip = new JSZip()
  const manifest = blocks.flatMap(block => block.sheets.map(sheet => ({ block: block.code, sheet: sheet.code, page: sheet.pageNumber, cards: sheet.cards.map(card => card.id) })))
  zip.file('manifiesto.json', JSON.stringify({ app: 'Bingo ProMax Studio', generatedAt: new Date().toISOString(), blocks: manifest }, null, 2))
  zip.file('manifiesto.csv', ['bloque,hoja,pagina,carton_1,carton_2,carton_3,carton_4', ...manifest.map(row => [row.block, row.sheet, row.page, ...row.cards].join(','))].join('\n'))
  for (const block of blocks) zip.file(`${block.code}.pdf`, createBlockPdf(block))
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

export function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function blocksToJson(blocks: BingoBlock[]) {
  return JSON.stringify(blocks, null, 2)
}

export function isPatternComplete(card: BingoCard, cells: number[], drawn: Set<number>) {
  return cells.every(index => {
    const row = Math.floor(index / 5)
    const col = index % 5
    const value = card.numbers[row][col]
    return value === 0 || drawn.has(value)
  })
}

export type ProMaxCard = {
  id: string
  number: string
  serial: string
  grid: number[]
  cardType: 'classic-5x5'
  layout: { type: 'classic-5x5'; name: string; rows: 5; columns: 5; cells: Array<{ row: number; column: number }> }
  sourceFile: string
  sourcePage: number
  status: 'active'
}

export type ProMaxPackage = {
  schemaVersion: '1.1'
  source: 'bingo-promax-studio'
  target: 'bingo-control-pro'
  generatedAt: string
  game: { id: string; name: string; date: string; prize: string; status: 'ready'; notes: string; activePatternId: string; activePatternName: string; activePatternCells: number[]; autoPause: boolean }
  blocks: BingoBlock[]
  cards: ProMaxCard[]
  campaigns: Array<{ code: string; blockCodes: string[] }>
}

export function createProMaxPackage(blocks: BingoBlock[]): ProMaxPackage {
  const campaigns = new Map<string, BingoBlock[]>()
  blocks.forEach(block => campaigns.set(block.campaign, [...(campaigns.get(block.campaign) ?? []), block]))
  const campaignCode = blocks[0]?.campaign ?? 'BPS-2026'
  const cards: ProMaxCard[] = blocks.flatMap(block => block.sheets.flatMap(sheet => sheet.cards.map(card => ({
    id: card.id,
    number: card.id,
    serial: sheet.code,
    grid: card.numbers.flat(),
    cardType: 'classic-5x5' as const,
    layout: { type: 'classic-5x5' as const, name: 'Tradicional 5×5', rows: 5 as const, columns: 5 as const, cells: Array.from({ length: 25 }, (_, index) => ({ row: Math.floor(index / 5), column: index % 5 })) },
    sourceFile: `${block.code}.pdf`,
    sourcePage: sheet.pageNumber,
    status: 'active' as const,
  }))))
  return { schemaVersion: '1.1', source: 'bingo-promax-studio', target: 'bingo-control-pro', generatedAt: new Date().toISOString(), game: { id: campaignCode, name: `Importación ${campaignCode}`, date: new Date().toISOString().slice(0, 10), prize: '', status: 'ready', notes: 'Partida preparada desde Bingo ProMax Studio.', activePatternId: 'linea-horizontal', activePatternName: 'Línea horizontal', activePatternCells: [10, 11, 12, 13, 14], autoPause: true }, blocks, cards, campaigns: [...campaigns.entries()].map(([code, campaignBlocks]) => ({ code, blockCodes: campaignBlocks.map(block => block.code) })) }
}

export function blocksToProMaxJson(blocks: BingoBlock[]) {
  return JSON.stringify(createProMaxPackage(blocks), null, 2)
}

export function blocksToProMaxCsv(blocks: BingoBlock[]) {
  const header = 'schema_version,source,target,campaign_code,block_code,sheet_code,page_number,card_id,number,serial,source_file,source_page,grid'
  const rows = blocks.flatMap(block => block.sheets.flatMap(sheet => sheet.cards.map(card => [
    '1.1', 'bingo-promax-studio', 'bingo-control-pro', block.campaign, block.code, sheet.code, sheet.pageNumber,
    card.id, card.id, sheet.code, `${block.code}.pdf`, sheet.pageNumber, card.numbers.flat().join('|'),
  ].map(value => `"${String(value).replaceAll('"', '""')}"`).join(','))))
  return [header, ...rows].join('\n')
}

export function parseProMaxPackage(raw: string): BingoBlock[] {
  const parsed = JSON.parse(raw) as Partial<ProMaxPackage>
  if (!['1.0', '1.1'].includes(String(parsed.schemaVersion)) || parsed.source !== 'bingo-promax-studio') throw new Error('El archivo no corresponde al paquete Bingo ProMax Studio v1.0 o v1.1.')
  const legacyCampaigns = parsed.campaigns as unknown as Array<{ blocks?: BingoBlock[] }>
  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : Array.isArray(legacyCampaigns) ? legacyCampaigns.flatMap(campaign => Array.isArray(campaign.blocks) ? campaign.blocks : []) : []
  if (!blocks.length || blocks.some(block => !block.code || !Array.isArray(block.sheets))) throw new Error('El paquete no contiene bloques válidos.')
  return blocks as BingoBlock[]
}
