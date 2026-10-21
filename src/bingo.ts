import { jsPDF } from 'jspdf'
import JSZip from 'jszip'

// 250.000 hojas equivalen a 1.000.000 de cartones. La generación continúa
// siendo por fragmentos para no bloquear la interfaz ni crear un ZIP gigante.
export const MAX_SHEETS = 250_000
export const SHEETS_PER_BLOCK = 40
export const CARDS_PER_SHEET = 4

export type BingoCard = {
  id: string
  numbers: number[][]
}

export type BingoPrintPattern = {
  name: string
  cells: number[]
  color?: string
}

export type BingoSheet = {
  code: string
  blockCode: string
  pageNumber: number
  cards: BingoCard[]
}

export type BingoPrintMetadata = {
  date?: string
  prizePlan?: string
  header?: string
  banner?: string
  patterns?: string[]
  patternDefinitions?: BingoPrintPattern[]
  notes?: string
  freeLabel?: string
}

export type BingoBlock = {
  code: string
  campaign: string
  range: string
  pages: number
  status: 'Listo' | 'Descargado' | 'Entregado'
  createdAt: string
  sheets: BingoSheet[]
  distributor?: string
  deliveredAt?: string
  notes?: string
  holderType?: 'admin' | 'distributor' | 'seller'
  holderId?: string
  holderName?: string
  watermark?: { text: string; opacity: number; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' }
  printMetadata?: BingoPrintMetadata
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

export function cardSignature(numbers: number[][]): string {
  return numbers.flat().join('-')
}

export function assertUniqueInventory(blocks: BingoBlock[]): void {
  const blockCodes = new Set<string>()
  const cardIds = new Set<string>()
  const signatures = new Set<string>()

  for (const block of blocks) {
    if (blockCodes.has(block.code)) throw new Error(`Código de bloque repetido: ${block.code}`)
    blockCodes.add(block.code)

    for (const sheet of block.sheets) {
      for (const card of sheet.cards) {
        if (cardIds.has(card.id)) throw new Error(`Código de cartón repetido: ${card.id}`)
        cardIds.add(card.id)
        const signature = cardSignature(card.numbers)
        if (signatures.has(signature)) throw new Error(`Cartón repetido: ${card.id}`)
        signatures.add(signature)
      }
    }
  }
}

export function assertGeneratedInventoryUnique(existingBlocks: BingoBlock[], campaign: string): void {
  assertUniqueInventory(existingBlocks)
  if (existingBlocks.some((block) => block.campaign === campaign)) {
    throw new Error(`El lote ${campaign} ya existe. Usa un nombre de lote distinto para no repetir códigos.`)
  }
}

function createCard(id: string, random: () => number): BingoCard {
  const columns = columnRanges.map(([from, to]) => {
    const pool = Array.from({ length: to - from + 1 }, (_, index) => from + index)
    return shuffle(pool, random).slice(0, 5).sort((a, b) => a - b)
  })
  const numbers = Array.from({ length: 5 }, (_, row) => columns.map((column, col) => row === 2 && col === 2 ? 0 : column[row]))
  return { id, numbers }
}

export function generateBatchChunk(campaign: string, totalSheets: number, startingPage = 1, startingBlockNumber = 1, usedCards = new Set<string>(), onProgress?: (percent: number) => void): BingoBlock[] {
  if (!Number.isInteger(totalSheets) || totalSheets < 1 || totalSheets > MAX_SHEETS) throw new Error(`El fragmento debe contener entre 1 y ${MAX_SHEETS.toLocaleString('es-EC')} hojas.`)
  const random = Math.random
  const blocks: BingoBlock[] = []
  const batchCode = campaign.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'BPS-2026'
  let page = startingPage
  for (let offset = 0; offset < totalSheets; offset += SHEETS_PER_BLOCK) {
    const blockSheets: BingoSheet[] = []
    const pageCount = Math.min(SHEETS_PER_BLOCK, totalSheets - offset)
    const blockNumber = startingBlockNumber + Math.floor(offset / SHEETS_PER_BLOCK)
    const blockCode = `${batchCode}-${String(blockNumber).padStart(3, '0')}`
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageNumber = page
      const sheets: BingoCard[] = []
      for (let cardIndex = 0; cardIndex < CARDS_PER_SHEET; cardIndex += 1) {
        let card = createCard(`${blockCode}-H${String(pageNumber).padStart(6, '0')}-C${cardIndex + 1}`, random)
        let signature = cardSignature(card.numbers)
        let attempts = 0
        while (usedCards.has(signature)) {
          if (attempts >= 1000) throw new Error('No fue posible obtener un cartón único. La generación se detuvo para proteger el inventario.')
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
    onProgress?.(Math.min(99, Math.round(((offset + pageCount) / totalSheets) * 100)))
  }
  onProgress?.(100)
  return blocks
}

export function generateBatch(campaign: string, totalSheets: number, startingPage = 1, onProgress?: (percent: number) => void): BingoBlock[] {
  if (!Number.isInteger(totalSheets) || totalSheets < 100 || totalSheets > MAX_SHEETS) throw new Error(`La cantidad debe estar entre 100 y ${MAX_SHEETS.toLocaleString('es-EC')} hojas.`)
  return generateBatchChunk(campaign, totalSheets, startingPage, 1, new Set<string>(), onProgress)
}

function addCard(doc: jsPDF, card: BingoCard, x: number, y: number, width: number, height: number, freeLabel = 'LIBRE') {
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
  const numberFontSize = Math.max(12, Math.min(16.2, cell * 1.24))
  doc.setFontSize(numberFontSize)
  const cardNumber = card.id.split('-').slice(-2).join('-') || card.id
  card.numbers.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
    const cx = startX + colIndex * cell
    const cy = y + (rowIndex + 1) * cell
    doc.setFillColor(value === 0 ? 209 : 247, value === 0 ? 181 : 246, value === 0 ? 70 : 231)
    doc.rect(cx, cy, cell, cell, 'FD')
    doc.setTextColor(value === 0 ? 40 : 28, value === 0 ? 31 : 35, value === 0 ? 14 : 32)
    if (value === 0) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(Math.max(3.4, Math.min(5.4, cell * .5)))
      doc.text(freeLabel.trim() || 'LIBRE', cx + cell / 2, cy + cell * .43, { align: 'center' })
      doc.setFont('courier', 'bold')
      doc.setFontSize(Math.max(2.5, Math.min(3.6, cell * .28)))
      doc.text(cardNumber, cx + cell / 2, cy + cell * .76, { align: 'center' })
    } else {
      doc.setFont('courier', 'bold')
      doc.setFontSize(numberFontSize)
      doc.text(String(value), cx + cell / 2, cy + cell * .66, { align: 'center' })
    }
  }))
  doc.setTextColor(70, 77, 72)
  doc.setFont('courier', 'normal')
  doc.setFontSize(Math.max(3.2, Math.min(4.1, cell * .3)))
  doc.text(card.id, startX + gridWidth / 2, y + gridHeight + cell * .55, { align: 'center', maxWidth: gridWidth - 2 })
}

function addPatternGlyph(doc: jsPDF, cells: number[], x: number, y: number, size: number, color = '#cda63f') {
  const cell = size / 5
  doc.setFillColor('#29312f')
  for (let index = 0; index < 25; index += 1) {
    const column = index % 5
    const row = Math.floor(index / 5)
    doc.rect(x + column * cell, y + row * cell, Math.max(.35, cell - .28), Math.max(.35, cell - .28), 'F')
  }
  doc.setFillColor(color)
  cells.forEach((index) => {
    if (index < 0 || index > 24) return
    const column = index % 5
    const row = Math.floor(index / 5)
    doc.rect(x + column * cell, y + row * cell, Math.max(.35, cell - .28), Math.max(.35, cell - .28), 'F')
  })
}

function addPatternPanel(doc: jsPDF, patterns: string[], definitions: BingoPrintPattern[] = [], x: number, y: number, width: number, height: number) {
  doc.setDrawColor(154, 122, 30)
  doc.setLineWidth(.45)
  doc.setFillColor(252, 250, 243)
  doc.roundedRect(x, y, width, height, 2, 2, 'FD')
  doc.setTextColor(104, 78, 12)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(5.2)
  doc.text('PATRONES DE JUEGO', x + width / 2, y + 7, { align: 'center' })
  const entries: BingoPrintPattern[] = definitions.length ? definitions : patterns.map(name => ({ name, cells: [] }))
  if (!entries.length) {
    doc.setTextColor(108, 116, 108)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(4.2)
    doc.text('Sin patrones seleccionados', x + width / 2, y + 15, { align: 'center', maxWidth: width - 6 })
    return
  }
  const columns = entries.length > 45 ? 3 : 2
  const columnWidth = (width - 6) / columns
  const rows = Math.ceil(entries.length / columns)
  const rowHeight = Math.min(10.2, Math.max(7.1, (height - 18) / rows))
  const iconSize = Math.min(6.2, Math.max(4.6, rowHeight - 1.2))
  const fontSize = entries.length > 45 ? 2.15 : 2.45
  const startY = y + 12.5
  entries.forEach((pattern, index) => {
    const column = Math.floor(index / rows)
    const row = index % rows
    const itemX = x + 2.5 + column * columnWidth
    const itemY = startY + row * rowHeight
    if (pattern.cells.length) addPatternGlyph(doc, pattern.cells, itemX, itemY - iconSize + 1, iconSize, pattern.color)
    else {
      doc.setFillColor(245, 200, 75)
      doc.circle(itemX + .8, itemY - 1.1, .65, 'F')
    }
    doc.setTextColor(45, 52, 49)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(fontSize)
    const label = doc.splitTextToSize(`${String(index + 1).padStart(2, '0')} ${pattern.name}`, columnWidth - iconSize - 3).slice(0, 1)
    doc.text(label[0], itemX + iconSize + 1.2, itemY - 1)
  })
  doc.setTextColor(104, 112, 104)
  doc.setFont('courier', 'normal')
  doc.setFontSize(3.4)
  doc.text(`${entries.length} patrón${entries.length === 1 ? '' : 'es'}`, x + width / 2, y + height - 4, { align: 'center' })
}

export function createBlockPdf(block: BingoBlock, watermark = block.watermark): ArrayBuffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  block.sheets.forEach((sheet, index) => {
    if (index > 0) doc.addPage()
    doc.setFillColor(13, 17, 17)
    doc.rect(0, 0, 210, 22, 'F')
    const metadata = block.printMetadata
    if (metadata?.banner) {
      try {
        const format = metadata.banner.startsWith('data:image/png') ? 'PNG' : 'JPEG'
        const properties = doc.getImageProperties(metadata.banner)
        const maxWidth = 210
        const maxHeight = 22
        // Llena todo el encabezado sin deformar el banner; el recorte queda
        // limitado al rectángulo A4 y nunca invade el contenido de la hoja.
        const scale = Math.max(maxWidth / properties.width, maxHeight / properties.height)
        const width = properties.width * scale
        const height = properties.height * scale
        doc.saveGraphicsState()
        doc.rect(0, 0, maxWidth, maxHeight, null).clip()
        doc.addImage(metadata.banner, format, (210 - width) / 2, (22 - height) / 2, width, height, 'studio-banner', 'FAST')
        doc.restoreGraphicsState()
      } catch {
        // If a legacy or invalid image is present, keep the text header and codes usable.
      }
    } else if (metadata?.header) {
      doc.setTextColor(245, 200, 75)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(14)
      doc.text(metadata.header, 14, 12)
    }
    // Contraste estable para los códigos aunque el banner sea claro o tenga mucho detalle.
    doc.setFillColor(13, 17, 17)
    doc.roundedRect(153, 3, 54, 16, 1.5, 1.5, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('courier', 'bold')
    doc.setFontSize(8.6)
    doc.text(`HOJA ${sheet.code}`, 196, 10, { align: 'right' })
    doc.text(`BLOQUE ${block.code}`, 196, 16, { align: 'right' })
    const metadataLines = [
      metadata?.date ? `Fecha: ${metadata.date}` : '',
      metadata?.prizePlan ? `Plan de premios: ${metadata.prizePlan}` : '',
    ].filter(Boolean)
    if (metadataLines.length) {
      doc.setTextColor(50, 58, 52)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7)
      metadataLines.slice(0, 2).forEach((line, lineIndex) => doc.text(line, 14, 28 + lineIndex * 4))
    }
    if (watermark?.text) {
      const shade = Math.max(150, Math.min(235, Math.round(235 - watermark.opacity * 180)))
      doc.setTextColor(shade, shade, shade)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      const coordinates = { 'top-left': [25, 35], 'top-right': [185, 35], 'bottom-left': [25, 270], 'bottom-right': [185, 270] } as const
      const [x, y] = coordinates[watermark.position]
      doc.text(watermark.text, x, y, { align: watermark.position.endsWith('right') ? 'right' : 'left', angle: -18 })
    }
    addPatternPanel(doc, metadata?.patterns ?? [], metadata?.patternDefinitions ?? [], 84, 39, 42, 185)
    const positions = [[8, 39], [122, 39], [8, 139], [122, 139]] as const
    sheet.cards.forEach((card, cardIndex) => addCard(doc, card, positions[cardIndex][0], positions[cardIndex][1], 80, 82, metadata?.freeLabel ?? 'LIBRE'))
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

export type ProMaxPattern = {
  id: string
  name: string
  description: string
  group: string
  color: string
  cells: number[]
  active: boolean
}

export type ProMaxPackage = {
  schemaVersion: '1.1'
  source: 'bingo-promax-studio'
  target: 'bingo-control-pro'
  generatedAt: string
  game: { id: string; name: string; date: string; prize: string; status: 'ready'; notes: string; activePatternId: string; activePatternName: string; activePatternCells: number[]; autoPause: boolean }
  blocks: BingoBlock[]
  cards: ProMaxCard[]
  patterns: ProMaxPattern[]
  campaigns: Array<{ code: string; blockCodes: string[] }>
}

export function createProMaxPackage(blocks: BingoBlock[], patterns: ProMaxPattern[] = []): ProMaxPackage {
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
  return { schemaVersion: '1.1', source: 'bingo-promax-studio', target: 'bingo-control-pro', generatedAt: new Date().toISOString(), game: { id: campaignCode, name: `Importación ${campaignCode}`, date: new Date().toISOString().slice(0, 10), prize: '', status: 'ready', notes: 'Partida preparada desde Bingo ProMax Studio.', activePatternId: 'linea-horizontal', activePatternName: 'Línea horizontal', activePatternCells: [10, 11, 12, 13, 14], autoPause: true }, blocks, cards, patterns, campaigns: [...campaigns.entries()].map(([code, campaignBlocks]) => ({ code, blockCodes: campaignBlocks.map(block => block.code) })) }
}

export function blocksToProMaxJson(blocks: BingoBlock[], patterns: ProMaxPattern[] = []) {
  return JSON.stringify(createProMaxPackage(blocks, patterns), null, 2)
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
