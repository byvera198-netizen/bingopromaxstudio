import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import JSZip from 'jszip'
import {
  assertGeneratedInventoryUnique,
  assertUniqueInventory,
  cardSignature,
  blocksToProMaxCsv,
  createBlockPdf,
  createBlocksZip,
  createProMaxPackage,
  generateBatch,
  generateBatchChunk,
  isPatternComplete,
  parseProMaxPackage,
  MAX_SHEETS,
  SHEETS_PER_BLOCK,
  CARDS_PER_SHEET,
} from '../src/bingo.ts'

function allSheets(blocks) {
  return blocks.flatMap((block) => block.sheets)
}

function allCards(blocks) {
  return allSheets(blocks).flatMap((sheet) => sheet.cards)
}

function assertValidCard(card) {
  assert.equal(card.numbers.length, 5)
  assert.equal(card.numbers.every((row) => row.length === 5), true)
  assert.equal(card.numbers[2][2], 0)

  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]]
  for (let column = 0; column < 5; column += 1) {
    for (let row = 0; row < 5; row += 1) {
      if (row === 2 && column === 2) continue
      const value = card.numbers[row][column]
      assert.equal(Number.isInteger(value), true)
      assert.equal(value >= ranges[column][0] && value <= ranges[column][1], true)
    }
  }
}

test('genera 100 hojas en bloques de 40, con 4 cartones 5x5 válidos', () => {
  const blocks = generateBatch('qa-100', 100)
  const sheets = allSheets(blocks)
  const cards = allCards(blocks)

  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks.map((block) => block.pages), [40, 40, 20])
  assert.equal(sheets.length, 100)
  assert.equal(cards.length, 400)
  assert.equal(new Set(cards.map((card) => card.id)).size, cards.length)
  assert.deepEqual(blocks.map((block) => block.code), ['QA-100-001', 'QA-100-002', 'QA-100-003'])
  assert.equal(blocks.every((block) => block.sheets.length <= SHEETS_PER_BLOCK), true)
  assert.equal(sheets.every((sheet) => sheet.cards.length === CARDS_PER_SHEET), true)
  cards.forEach(assertValidCard)
})

test('genera 1.000 hojas y mantiene la numeración continua', () => {
  const blocks = generateBatch('qa-1000', 1000)
  const sheets = allSheets(blocks)

  assert.equal(blocks.length, 25)
  assert.equal(sheets.length, 1000)
  assert.equal(sheets[0].pageNumber, 1)
  assert.equal(sheets.at(-1).pageNumber, 1000)
  assert.equal(sheets.every((sheet, index) => sheet.pageNumber === index + 1), true)
  assert.equal(new Set(allCards(blocks).map((card) => card.id)).size, 4000)
})

test('permite continuar por fragmentos sin reiniciar hojas ni bloques', () => {
  const usedSignatures = new Set()
  const first = generateBatchChunk('qa-resume', 40, 1, 1, usedSignatures)
  const second = generateBatchChunk('qa-resume', 60, 41, 2, usedSignatures)
  const blocks = [...first, ...second]
  const cards = allCards(blocks)

  assert.deepEqual(blocks.map((block) => block.code), ['QA-RESUME-001', 'QA-RESUME-002', 'QA-RESUME-003'])
  assert.deepEqual(blocks.map((block) => block.pages), [40, 40, 20])
  assert.equal(allSheets(blocks)[0].pageNumber, 1)
  assert.equal(allSheets(blocks).at(-1).pageNumber, 100)
  assert.equal(new Set(cards.map((card) => cardSignature(card.numbers))).size, cards.length)
})

test('rechaza cartones repetidos y códigos repetidos en todo el inventario', () => {
  const blocks = generateBatch('qa-unique-inventory', 100)
  assert.doesNotThrow(() => assertUniqueInventory(blocks))

  const duplicateCardBlocks = [blocks[0], { ...blocks[1], sheets: blocks[1].sheets.map((sheet, sheetIndex) => sheetIndex === 0 ? { ...sheet, cards: [blocks[0].sheets[0].cards[0], ...sheet.cards.slice(1)] } : sheet) }]
  assert.throws(() => assertUniqueInventory(duplicateCardBlocks), /cartón repetido/i)
  assert.throws(() => assertGeneratedInventoryUnique(blocks, 'QA-UNIQUE-INVENTORY'), /ya existe/)
})

test('rechaza cantidades fuera del rango operativo', () => {
  assert.throws(() => generateBatch('invalid-low', 99), /entre 100/)
  assert.throws(() => generateBatch('invalid-high', MAX_SHEETS + 1), /entre 100/)
})

test('crea y valida el paquete administrativo JSON v1.1', () => {
  const blocks = generateBatch('qa-package', 100)
  const packageData = createProMaxPackage(blocks, [{
    id: 'linea-horizontal',
    name: 'Línea horizontal',
    description: 'Una línea completa',
    group: 'Básicos',
    color: '#b9ed2c',
    cells: [10, 11, 12, 13, 14],
    active: true,
  }])
  const roundTrip = parseProMaxPackage(JSON.stringify(packageData))

  assert.equal(packageData.schemaVersion, '1.1')
  assert.equal(packageData.source, 'bingo-promax-studio')
  assert.equal(packageData.target, 'bingo-control-pro')
  assert.equal(packageData.cards.length, 400)
  assert.deepEqual(roundTrip, blocks)
  assert.throws(() => parseProMaxPackage('{"blocks":[]}'), /paquete|archivo/)
})

test('produce CSV, PDF y ZIP con manifiesto verificable', async () => {
  const blocks = generateBatch('qa-files', 100)
  const firstBlock = blocks[0]
  const csv = blocksToProMaxCsv(blocks)
  const pdf = createBlockPdf(firstBlock)
  const zipBlob = await createBlocksZip(blocks)
  const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer())
  const entries = Object.keys(zip.files)

  assert.match(csv, /^schema_version,source,target,campaign_code/m)
  assert.equal(csv.split('\n').length, 401)
  assert.equal(pdf.byteLength > 1000, true)
  assert.equal(entries.includes('manifiesto.json'), true)
  assert.equal(entries.includes('manifiesto.csv'), true)
  assert.equal(entries.filter((name) => name.endsWith('.pdf')).length, 3)
})

test('evalúa un patrón usando bolilla extraída y centro libre', () => {
  const card = generateBatch('qa-pattern', 100)[0].sheets[0].cards[0]
  const cells = [10, 11, 12, 13, 14]
  const drawn = new Set(cells.map((index) => card.numbers[Math.floor(index / 5)][index % 5]))

  assert.equal(isPatternComplete(card, cells, drawn), true)
  const incompleteDrawn = new Set([...drawn].slice(0, 4))
  assert.equal(isPatternComplete(card, cells, incompleteDrawn), false)
})

test('mantiene las políticas de mínimo privilegio en la migración backend', async () => {
  const migration = await readFile(new URL('../supabase/002_backend_hardening.sql', import.meta.url), 'utf8')

  assert.match(migration, /studio_generation_jobs/)
  assert.match(migration, /lower\(email\) = lower\(coalesce\(auth\.jwt\(\) ->> 'email'/)
  assert.match(migration, /lower\(actor_email\) = lower\(coalesce\(auth\.jwt\(\) ->> 'email'/)
  assert.match(migration, /alter table public\.studio_generation_jobs enable row level security/)
})
