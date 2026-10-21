import { useEffect, useState } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { blocksToJson, blocksToProMaxCsv, blocksToProMaxJson as blocksToProMaxJsonBase, cardSignature, createBlockPdf, createBlocksZip, isPatternComplete, parseProMaxPackage, triggerDownload, type BingoBlock, type BingoCard, type BingoPrintMetadata } from './bingo'
import { supabase } from './supabase'
import { clearStudioGenerationCheckpoint, createStudioAdmin, createStudioClient, createStudioPartyAccount, deleteStudioAdmin, deleteStudioBlock, deleteStudioGame, deleteStudioPartyAccount, deleteStudioPattern, deleteStudioHeader, loadStudioAuditEvents, loadStudioBlocks, loadStudioGame, loadStudioGenerationCheckpoint, loadStudioHeaders, loadStudioMember, loadStudioMembers, loadStudioNetwork, loadStudioPatterns, loadStudioTenants, loadStudioWatermarks, recordStudioSale, saveStudioGenerationCheckpoint, saveStudioHeader, saveStudioWatermark, syncStudioBlock, syncStudioGame, syncStudioInventory, syncStudioPatterns, transferStudioBlock, updateStudioPartyAccount, writeStudioAudit, type StudioClient, type StudioGame, type StudioHeader, type StudioMember, type StudioTenant, type StudioParty, type StudioSale, type StudioTransfer, type StudioWatermark } from './studio-backend'
import './styles.css'
import './generator.css'

const ALLOWED_EMAILS = ['byvera198@gmail.com', 'bveraalvear@gmail.com']
const STUDIO_AUTH_REDIRECT_URL = import.meta.env.VITE_STUDIO_AUTH_REDIRECT_URL ?? 'https://bingopromaxstudio.pages.dev'

type View = 'dashboard' | 'generator' | 'blocks' | 'games' | 'patterns' | 'integration' | 'users' | 'network' | 'audit'
type Pattern = { id: string; name: string; description: string; group: string; color: string; cells: number[]; active: boolean }
type AuditEvent = { id: string; action: string; detail: string; actor: string; createdAt: string }
const permissionOptions: Array<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Resumen' },
  { id: 'generator', label: 'Generador' },
  { id: 'blocks', label: 'Bloques' },
  { id: 'games', label: 'Partidas' },
  { id: 'patterns', label: 'Patrones' },
  { id: 'integration', label: 'Integración' },
  { id: 'audit', label: 'Auditoría' },
]

const BLOCK_DB_NAME = 'bingo-promax-studio'
const BLOCK_DB_VERSION = 2
const SNAPSHOT_STORE_NAME = 'snapshots'
const BLOCK_STORE_NAME = 'blocks'
const GENERATION_STORE_NAME = 'generationJobs'
const MAX_BULK_ZIP_SHEETS = 2000
const GENERATION_CHUNK_SHEETS = 400

type GenerationCheckpoint = {
  id: 'active'
  campaign: string
  totalSheets: number
  completedSheets: number
  nextPage: number
  nextBlockNumber: number
  updatedAt: string
}

function tenantKey(tenantId?: string | null) { return tenantId ? tenantId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48) : 'shared' }

function openBlockDatabase(tenantId?: string | null): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB no está disponible en este navegador.'))
      return
    }
    const request = window.indexedDB.open(BLOCK_DB_NAME + '-' + tenantKey(tenantId), BLOCK_DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) request.result.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' })
      if (!request.result.objectStoreNames.contains(BLOCK_STORE_NAME)) request.result.createObjectStore(BLOCK_STORE_NAME, { keyPath: 'code' })
      if (!request.result.objectStoreNames.contains(GENERATION_STORE_NAME)) request.result.createObjectStore(GENERATION_STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir el almacenamiento local.'))
  })
}

async function persistBlocks(blocks: BingoBlock[], syncRemote = true, tenantId?: string | null) {
  const totalSheets = blocks.reduce((total, block) => total + block.pages, 0)
  try {
    const key = 'bps-blocks-' + tenantKey(tenantId)
    if (totalSheets <= 2000) localStorage.setItem(key, JSON.stringify(blocks))
    else localStorage.removeItem(key)
  } catch { /* IndexedDB below is the durable path for large inventories. */ }
  try {
    const database = await openBlockDatabase(tenantId)
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOT_STORE_NAME, BLOCK_STORE_NAME], 'readwrite')
      const blockStore = transaction.objectStore(BLOCK_STORE_NAME)
      blockStore.clear()
      blocks.forEach((block) => blockStore.put(block))
      transaction.objectStore(SNAPSHOT_STORE_NAME).put({ id: 'current', blocks, savedAt: new Date().toISOString() })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('No se pudo guardar el inventario.')) }
    })
  } catch { /* The in-memory inventory remains available for the current session. */ }
  if (syncRemote) {
    try { await syncStudioInventory(blocks, tenantId) } catch { /* The local inventory remains the offline source of truth. */ }
  }
}

async function persistGenerationChunk(blocks: BingoBlock[], tenantId?: string | null) {
  if (!blocks.length) return
  const database = await openBlockDatabase(tenantId)
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(BLOCK_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(BLOCK_STORE_NAME)
    blocks.forEach((block) => store.put(block))
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('No se pudo guardar el fragmento generado.')) }
  })
}

async function saveGenerationCheckpoint(checkpoint: GenerationCheckpoint, tenantId?: string | null) {
  try {
    const database = await openBlockDatabase(tenantId)
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(GENERATION_STORE_NAME, 'readwrite')
      transaction.objectStore(GENERATION_STORE_NAME).put(checkpoint)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('No se pudo guardar el checkpoint.')) }
    })
  } catch { /* Supabase remains available when IndexedDB is unavailable. */ }
  try { await saveStudioGenerationCheckpoint(checkpoint, tenantId) } catch { /* Supabase is optional until the migration is applied. */ }
}

async function loadGenerationCheckpoint(tenantId?: string | null): Promise<GenerationCheckpoint | null> {
  try {
    const remote = await loadStudioGenerationCheckpoint(tenantId)
    if (remote) return remote
  } catch { /* Use the local checkpoint when the migration or network is unavailable. */ }
  try {
    const database = await openBlockDatabase(tenantId)
    const checkpoint = await new Promise<GenerationCheckpoint | undefined>((resolve, reject) => {
      const request = database.transaction(GENERATION_STORE_NAME, 'readonly').objectStore(GENERATION_STORE_NAME).get('active')
      request.onsuccess = () => resolve(request.result as GenerationCheckpoint | undefined)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return checkpoint ?? null
  } catch { return null }
}

async function clearGenerationCheckpoint(campaign: string, tenantId?: string | null) {
  try {
    const database = await openBlockDatabase(tenantId)
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(GENERATION_STORE_NAME, 'readwrite')
      transaction.objectStore(GENERATION_STORE_NAME).delete('active')
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    })
  } catch { /* A completed generation remains usable even if cleanup is unavailable. */ }
  try { await clearStudioGenerationCheckpoint(campaign, tenantId) } catch { /* Local completion remains authoritative offline. */ }
}

async function loadPersistedBlocks(tenantId?: string | null): Promise<BingoBlock[]> {
  let remoteBlocks: BingoBlock[] = []
  try {
    remoteBlocks = await loadStudioBlocks(tenantId)
  } catch { /* The migration may not be installed yet; use local persistence. */ }
  try {
    const database = await openBlockDatabase(tenantId)
    const storedBlocks = await new Promise<BingoBlock[]>((resolve, reject) => {
      const request = database.transaction(BLOCK_STORE_NAME, 'readonly').objectStore(BLOCK_STORE_NAME).getAll()
      request.onsuccess = () => resolve((request.result as BingoBlock[] | undefined) ?? [])
      request.onerror = () => reject(request.error)
    })
    if (storedBlocks.length) {
      database.close()
      const merged = new Map(remoteBlocks.map((block) => [block.code, block]))
      storedBlocks.forEach((block) => merged.set(block.code, block))
      return [...merged.values()]
    }
    const snapshot = await new Promise<{ blocks?: BingoBlock[] } | undefined>((resolve, reject) => {
      const request = database.transaction(SNAPSHOT_STORE_NAME, 'readonly').objectStore(SNAPSHOT_STORE_NAME).get('current')
      request.onsuccess = () => resolve(request.result as { blocks?: BingoBlock[] } | undefined)
      request.onerror = () => reject(request.error)
    })
    database.close()
    if (Array.isArray(snapshot?.blocks) && snapshot.blocks.length) return snapshot.blocks
  } catch { /* Fall back to the fast localStorage path. */ }
  if (remoteBlocks.length) return remoteBlocks
  try {
    const stored = JSON.parse(localStorage.getItem('bps-blocks-' + tenantKey(tenantId)) ?? '[]')
    return Array.isArray(stored) ? stored as BingoBlock[] : []
  } catch { return [] }
}

function appendAudit(action: string, detail: string) {
  try {
    const current: AuditEvent[] = JSON.parse(localStorage.getItem('bps-audit') ?? '[]')
    const event: AuditEvent = { id: crypto.randomUUID(), action, detail, actor: localStorage.getItem('bps-email') ?? 'desconocido', createdAt: new Date().toISOString() }
    localStorage.setItem('bps-audit', JSON.stringify([event, ...current].slice(0, 1000)))
  } catch { /* storage unavailable */ }
  void writeStudioAudit(action, detail).catch(() => { /* Offline mode keeps the local audit trail. */ })
}

const seedPatterns: Pattern[] = [
  { id: 'full', name: 'Cartón lleno', description: 'Completar todas las casillas impresas.', group: 'Clásicos', color: '#f5c84b', cells: Array.from({ length: 25 }, (_, i) => i), active: true },
  { id: 'letter-a', name: 'Letra A', description: 'Figura con forma de A.', group: 'Letras', color: '#b9ed2c', cells: [0, 1, 2, 3, 4, 5, 9, 6, 8, 10, 12, 15, 20], active: true },
]

const maskFor = (...rows: string[]) => rows.flatMap((row, rowIndex) => [...row].map((cell, colIndex) => cell === '1' ? rowIndex * 5 + colIndex : -1)).filter(index => index >= 0)
const letterMasks: Record<string, number[]> = {
  B: maskFor('11110','10001','11110','10001','11110'), C: maskFor('01111','10000','10000','10000','01111'), D: maskFor('11110','10001','10001','10001','11110'),
  E: maskFor('11111','10000','11110','10000','11111'), F: maskFor('11111','10000','11110','10000','10000'), G: maskFor('01111','10000','10111','10001','01111'),
  H: maskFor('10001','10001','11111','10001','10001'), I: maskFor('11111','00100','00100','00100','11111'), J: maskFor('00111','00010','00010','10010','01100'),
  K: maskFor('10001','10010','11100','10010','10001'), L: maskFor('10000','10000','10000','10000','11111'), M: maskFor('10001','11011','10101','10001','10001'),
  N: maskFor('10001','11001','10101','10011','10001'), O: maskFor('01110','10001','10001','10001','01110'), P: maskFor('11110','10001','11110','10000','10000'),
  Q: maskFor('01110','10001','10001','10101','01111'), R: maskFor('11110','10001','11110','10010','10001'), S: maskFor('01111','10000','01110','00001','11110'),
  T: maskFor('11111','00100','00100','00100','00100'), U: maskFor('10001','10001','10001','10001','01110'), V: maskFor('10001','10001','10001','01010','00100'),
  W: maskFor('10001','10001','10101','11011','10001'), X: maskFor('10001','01010','00100','01010','10001'), Y: maskFor('10001','01010','00100','00100','00100'), Z: maskFor('11111','00010','00100','01000','11111'),
}
const numberMasks: Record<string, number[]> = {
  '0': maskFor('01110','10001','10011','10101','01110'), '1': maskFor('00100','01100','00100','00100','01110'), '2': maskFor('01110','10001','00010','00100','11111'),
  '3': maskFor('11110','00001','01110','00001','11110'), '4': maskFor('10010','10010','11111','00010','00010'), '5': maskFor('11111','10000','11110','00001','11110'),
  '6': maskFor('01110','10000','11110','10001','01110'), '7': maskFor('11111','00010','00100','01000','01000'), '8': maskFor('01110','10001','01110','10001','01110'), '9': maskFor('01110','10001','01111','00001','01110'),
}
const extraNames = ['Letra B','Letra C','Letra D','Letra E','Letra F','Letra G','Letra H','Letra I','Letra J','Letra K','Letra L','Letra M','Letra N','Letra O','Letra P','Letra Q','Letra R','Letra S','Letra T','Letra U','Letra V','Letra W','Letra X','Letra Y','Letra Z','Número 1','Número 2','Número 3','Número 4','Número 5','Número 6','Número 7','Número 8','Número 9']
const legacyPatternNames = new Set(['Número 0','Forma #1 completa','Forma #3 completa','Forma #4 completa','Forma #5 completa','Forma #7 completa','Forma #9 completa','Eche Leche','Bombombum','Keke Keke','Yapa','Avión','Flecha','Espada','Pesa','Rombo','Bomba','Sonrisa','Mini O','Perrito','Cruz','Más','Martillo'])
const specialMasks = [maskFor('11111','10001','10001','10001','11111'), maskFor('00100','01110','11111','01110','00100'), maskFor('10001','01010','00100','01010','10001'), maskFor('11111','00100','00100','00100','11111'), maskFor('11111','10000','11110','10000','11111'), maskFor('10001','11011','10101','11011','10001'), maskFor('00100','01110','11111','01110','00100'), maskFor('10000','11000','10100','10010','10001'), maskFor('00001','00010','00100','01000','10000'), maskFor('10001','01010','00100','01010','10001'), maskFor('00100','01010','10001','01010','00100'), maskFor('01110','10001','10101','10001','01110'), maskFor('10001','01010','00100','01010','10001'), maskFor('00100','01110','00100','11111','00100'), maskFor('10001','10001','11111','10001','10001'), maskFor('01110','10001','11111','10001','01110'), maskFor('11111','10000','11111','10000','11111'), maskFor('10001','10101','10001','10101','10001'), maskFor('11111','10101','11111','10101','11111'), maskFor('10000','10000','11111','10000','10000')]
const extraPatterns: Pattern[] = extraNames.map((name, index) => { const key = name.replace('Letra ', '').replace('Número ', ''); const cells = name.startsWith('Letra ') ? (letterMasks[key] ?? []) : (numberMasks[key] ?? []); const group = name.startsWith('Letra ') ? 'Letras' : 'Números'; return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, description: `Figura ${name.toLowerCase()} para jugar en una partida.`, group, color: ['#b9ed2c','#6ee7d1','#bda1ff','#ff9e5c','#ef7898'][index % 5], cells, active: name === 'Letra B' || name === 'Letra C' } })
const patternCatalog: Pattern[] = [...seedPatterns, ...extraPatterns]
function readPatternCatalog(): Pattern[] { try { const saved: Pattern[] = JSON.parse(localStorage.getItem('bps-patterns') ?? '[]'); return patternCatalog.map(pattern => saved.find(item => item.id === pattern.id) ?? pattern).concat(saved.filter(item => !patternCatalog.some(pattern => pattern.id === item.id) && !legacyPatternNames.has(item.name))) } catch { return patternCatalog } }
function mergePatternCatalog(remote: Pattern[]): Pattern[] {
  const local = readPatternCatalog()
  const remoteById = new Map(remote.filter(pattern => !legacyPatternNames.has(pattern.name)).map(pattern => [pattern.id, pattern]))
  const merged = local.map(pattern => remoteById.get(pattern.id) ?? pattern)
  remote.filter(pattern => !legacyPatternNames.has(pattern.name) && !merged.some(existing => existing.id === pattern.id)).forEach(pattern => merged.push(pattern))
  return merged
}
function blocksToProMaxJson(blocks: BingoBlock[]) { return blocksToProMaxJsonBase(blocks, readPatternCatalog().map(pattern => ({ id: pattern.id, name: pattern.name, description: pattern.description, group: pattern.group, color: pattern.color, cells: pattern.cells, active: pattern.active }))) }

const sampleCard = [
  [4, 18, 31, 47, 69],
  [8, 22, 35, 52, 73],
  [2, 27, 0, 56, 66],
  [14, 24, 39, 59, 71],
  [11, 20, 42, 50, 64],
]

const demoCard: BingoCard = { id: 'DEMO-H000001-C1', numbers: sampleCard }

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><div className="brand-mark">B</div><div><strong>BINGO</strong><span>ProMax Studio</span></div></div>
}

function Icon({ name }: { name: string }) {
  const icons: Record<string, string> = { grid: '▦', play: '▷', layers: '▤', spark: '✦', users: '♙', audit: '◷', settings: '⚙', download: '↓', plus: '+', arrow: '→', check: '✓', lock: '⌑' }
  return <span className="icon" aria-hidden="true">{icons[name] ?? '•'}</span>
}

function canAccessView(member: StudioMember | null, view: View) {
  if (!member || member.role === 'developer' || member.role === 'admin') return true
  if (view === 'network') return member.role === 'distributor' || member.role === 'seller'
  return member.permissions[view] === true
}

function roleLabel(role: StudioMember['role'] | undefined) {
  return role === 'developer' ? 'Desarrollador' : role === 'admin' ? 'Administrador' : role === 'distributor' ? 'Distribuidor' : role === 'seller' ? 'Vendedor' : 'Operador'
}

function Login({ onLogin }: { onLogin: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    if (!normalized.includes('@')) { setError('Escribe un correo válido.'); return }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await onLogin(normalized)
      setMessage('Enlace enviado. Revisa tu correo y vuelve a abrir el enlace para entrar al Studio.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo enviar el enlace de acceso.')
    } finally { setBusy(false) }
  }
  return <main className="login-shell">
    <div className="login-glow glow-one" /><div className="login-glow glow-two" />
    <section className="login-card">
      <Logo />
      <div className="eyebrow">CENTRO DE OPERACIONES</div>
      <h1>Todo el control de tus cartones.</h1>
      <p className="muted">Genera, organiza y prepara tus partidas desde un solo espacio profesional.</p>
      <form onSubmit={submit} className="login-form">
        <label>Correo autorizado<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu-correo@dominio.com" autoFocus /></label>
        {error && <div className="error-box">{error}</div>}
        {message && <div className="success-box">{message}</div>}
        <button className="primary wide" disabled={busy} type="submit">{busy ? 'Enviando enlace…' : 'Enviar enlace de acceso'} <Icon name={busy ? 'lock' : 'arrow'} /></button>
      </form>
      <div className="login-note"><Icon name="lock" /> Acceso privado con enlace de un solo uso</div>
    </section>
  </main>
}

function Sidebar({ view, setView, email, blocks, member }: { view: View; setView: (view: View) => void; email: string; blocks: BingoBlock[]; member: StudioMember | null }) {
  const sections = [
    { label: 'OPERACIÓN', items: [['dashboard', 'grid', 'Resumen'], ['generator', 'spark', 'Generar cartones'], ['blocks', 'layers', 'Bloques y hojas'], ['network', 'users', 'Red comercial'], ['games', 'play', 'Sala de juego']] },
    { label: 'CONFIGURACIÓN', items: [['patterns', 'spark', 'Patrones'], ['integration', 'arrow', 'Integración ProMax'], ['users', 'users', 'Usuarios'], ['audit', 'audit', 'Auditoría']] },
  ] as const
  return <aside className="sidebar">
    <div className="sidebar-top"><Logo compact /><button className="collapse" aria-label="Contraer menú" disabled>‹</button></div>
    <div className="profile"><div className="avatar">{email[0].toUpperCase()}</div><div><strong>{roleLabel(member?.role)}</strong><span>{email}</span></div><span className="online" /></div>
    <nav>{sections.map(section => <div className="nav-section" key={section.label}><div className="nav-label">{section.label}</div>{section.items.filter(([id]) => canAccessView(member, id as View)).map(([id, icon, label]) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id as View)}><Icon name={icon} /><span>{label}</span>{id === 'blocks' && <em>{blocks.length}</em>}</button>)}</div>)}</nav>
    <div className="sidebar-bottom"><div className="plan-card"><span className="plan-icon">✦</span><div><b>Studio Premium</b><small>Entorno protegido</small></div></div><button className="nav-item"><Icon name="settings" /><span>Configuración</span></button></div>
  </aside>
}

function Topbar({ view, onLogout, tenants, activeTenantId, onTenantChange }: { view: View; onLogout: () => void; tenants: StudioTenant[]; activeTenantId?: string; onTenantChange: (tenantId: string) => void }) {
  const titles: Record<View, [string, string]> = { dashboard: ['Resumen general', 'Tu operación, en un vistazo.'], generator: ['Generador de cartones', 'Crea hojas listas para distribuir.'], blocks: ['Bloques y hojas', 'Organiza tus lotes de distribución.'], network: ['Red comercial', 'Distribuidores, vendedores y transferencias.'], games: ['Sala de juego', 'Prepara y controla una nueva partida.'], patterns: ['Patrones de juego', 'Define las figuras que se jugarán.'], integration: ['Integración ProMax', 'Intercambia cartones y partidas con Bingo Control ProMax.'], users: ['Usuarios y accesos', 'Administra el equipo autorizado.'], audit: ['Auditoría', 'Actividad reciente del estudio.'] }
  return <header className="topbar"><div><div className="breadcrumb">BINGO PROMAX STUDIO <span>/</span> {titles[view][0].toUpperCase()}</div><h2>{titles[view][0]}</h2></div><div className="top-actions">{tenants.length > 0 && <select className="tenant-select" value={activeTenantId ?? ''} onChange={event => onTenantChange(event.target.value)} aria-label="Espacio de administrador">{tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select>}<div className="status-dot"><span /> Sistema operativo</div><button className="ghost" onClick={onLogout}>Salir</button><button className="user-mini">BV</button></div></header>
}

function StatCard({ label, value, detail, accent, icon }: { label: string; value: string; detail: string; accent: string; icon: string }) {
  return <article className="stat-card"><div className="stat-icon" style={{ color: accent, background: `${accent}14` }}><Icon name={icon} /></div><div className="stat-label">{label}</div><strong>{value}</strong><small>{detail}</small><div className="stat-line" style={{ background: accent }} /></article>
}

function Dashboard({ setView, blocks }: { setView: (view: View) => void; blocks: BingoBlock[] }) {
  return <div className="page-content">
    <section className="hero-panel"><div><div className="eyebrow">BINGO PROMAX STUDIO <span className="live-pill">● LISTO</span></div><h1>Tu operación,<br /><span>más clara y más rápida.</span></h1><p>Gestiona cartones, bloques y partidas desde un centro de operaciones diseñado para crecer contigo.</p><button className="primary" onClick={() => setView('generator')}>Crear cartones <Icon name="arrow" /></button></div><div className="hero-orbit"><div className="orbit-ring ring-a" /><div className="orbit-ring ring-b" /><div className="hero-badge"><b>75</b><span>bolillas</span></div><div className="orbit-dot dot-a" /><div className="orbit-dot dot-b" /><div className="orbit-dot dot-c" /></div></section>
    <div className="stats-grid"><StatCard label="Hojas generadas" value={blocks.reduce((total, block) => total + block.pages, 0).toLocaleString('es-EC')} detail="Inventario local del estudio" accent="#f5c84b" icon="layers" /><StatCard label="Cartones activos" value={(blocks.reduce((total, block) => total + block.pages, 0) * 4).toLocaleString('es-EC')} detail="4 por cada hoja" accent="#6ee7d1" icon="grid" /><StatCard label="Partidas realizadas" value="0" detail="Registro local disponible" accent="#b9ed2c" icon="play" /><StatCard label="Patrones disponibles" value={String(readPatternCatalog().length)} detail={`${readPatternCatalog().filter(pattern => pattern.active).length} habilitados`} accent="#bda1ff" icon="spark" /></div>
    <div className="content-grid"><section className="panel activity-panel"><div className="panel-heading"><div><div className="eyebrow">ACTIVIDAD RECIENTE</div><h3>Últimas operaciones</h3></div><button className="text-button" onClick={() => setView('audit')}>Ver auditoría <Icon name="arrow" /></button></div><div className="activity-list"><Activity icon="spark" color="#f5c84b" title="Lote generado" description="Bloque BP-2026-003 creado con 40 hojas" time="Hace 12 min" /><Activity icon="download" color="#6ee7d1" title="Descarga completada" description="Distribución Norte descargó BP-2026-002" time="Hace 1 h" /><Activity icon="play" color="#b9ed2c" title="Partida finalizada" description="Partida Nueva jornada · 3 ganadores" time="Ayer, 18:42" /><Activity icon="users" color="#bda1ff" title="Acceso autorizado" description="bveraalvear@gmail.com inició sesión" time="Ayer, 09:15" /></div></section><section className="panel quick-panel"><div className="eyebrow">ACCESOS RÁPIDOS</div><h3>¿Qué quieres hacer?</h3><QuickAction icon="spark" title="Generar cartones" text="Crea una nueva tanda" onClick={() => setView('generator')} /><QuickAction icon="play" title="Preparar partida" text="Selecciona tus patrones" onClick={() => setView('games')} /><QuickAction icon="layers" title="Ver bloques" text="Gestiona tus entregas" onClick={() => setView('blocks')} /></section></div>
  </div>
}

function Activity({ icon, color, title, description, time }: { icon: string; color: string; title: string; description: string; time: string }) { return <div className="activity-row"><div className="activity-icon" style={{ color, background: `${color}18` }}><Icon name={icon} /></div><div><b>{title}</b><span>{description}</span></div><time>{time}</time></div> }
function QuickAction({ icon, title, text, onClick }: { icon: string; title: string; text: string; onClick: () => void }) { return <button className="quick-action" onClick={onClick}><div className="quick-icon"><Icon name={icon} /></div><div><b>{title}</b><span>{text}</span></div><Icon name="arrow" /></button> }

type GenerationUpdate = 'checkpoint' | 'complete'

function Generator({ onGenerated, setView, tenantId, existingBlocks }: { onGenerated: (blocks: BingoBlock[], update?: GenerationUpdate) => void; setView: (view: View) => void; tenantId?: string; existingBlocks: BingoBlock[] }) {
  const [sheets, setSheets] = useState(100)
  const [code, setCode] = useState('BP-2026')
  const [gameDate, setGameDate] = useState('')
  const [prizePlan, setPrizePlan] = useState('')
  const [header, setHeader] = useState('')
  const [banner, setBanner] = useState('')
  const [freeLabel, setFreeLabel] = useState('LIBRE')
  const [watermarkText, setWatermarkText] = useState('')
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.12)
  const [watermarkPosition, setWatermarkPosition] = useState<NonNullable<BingoBlock['watermark']>['position']>('bottom-right')
  const [selectedPatternIds, setSelectedPatternIds] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const [generated, setGenerated] = useState<BingoBlock[]>([])
  const [error, setError] = useState('')
  const [resumeJob, setResumeJob] = useState<GenerationCheckpoint | null>(null)
  const [patternOptions, setPatternOptions] = useState<Pattern[]>(readPatternCatalog)
  useEffect(() => {
    let active = true
    void loadStudioPatterns(tenantId).then(remote => {
      if (!active || !remote.length) return
      const merged = mergePatternCatalog(remote)
      setPatternOptions(merged)
      localStorage.setItem('bps-patterns', JSON.stringify(merged))
    }).catch(() => { /* The local catalog remains available if Supabase is offline. */ })
    return () => { active = false }
  }, [tenantId])
  const printMetadata = (): BingoPrintMetadata => ({
    date: gameDate.trim() || undefined,
    prizePlan: prizePlan.trim() || undefined,
    header: header.trim() || undefined,
    banner: banner || undefined,
    freeLabel: freeLabel.trim() || 'LIBRE',
    patterns: patternOptions.filter(pattern => selectedPatternIds.includes(pattern.id)).map(pattern => pattern.name),
    patternDefinitions: patternOptions.filter(pattern => selectedPatternIds.includes(pattern.id)).map(pattern => ({ name: pattern.name, cells: pattern.cells, color: pattern.color })),
    notes: notes.trim() || undefined,
  })
  const loadBanner = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('Selecciona una imagen válida para el banner.'); return }
    if (file.size > 8 * 1024 * 1024) { setError('El banner no puede superar 8 MB.'); return }
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        const maxWidth = 1400
        const maxHeight = 220
        const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight)
        const width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = Math.max(1, Math.round(image.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) { setError('No se pudo preparar el banner.'); return }
        context.fillStyle = '#0d1111'
        context.fillRect(0, 0, width, height)
        context.drawImage(image, 0, 0, width, height)
        setBanner(canvas.toDataURL('image/jpeg', 0.82))
        setError('')
      }
      image.onerror = () => setError('No se pudo leer el banner seleccionado.')
      image.src = String(reader.result)
    }
    reader.onerror = () => setError('No se pudo leer el archivo del banner.')
    reader.readAsDataURL(file)
  }
  const decorateBlocks = (blocks: BingoBlock[]) => blocks.map(block => ({
    ...block,
    printMetadata: printMetadata(),
    watermark: watermarkText.trim() ? { text: watermarkText.trim(), opacity: watermarkOpacity, position: watermarkPosition } : undefined,
  }))
  useEffect(() => { void loadGenerationCheckpoint(tenantId).then(setResumeJob) }, [tenantId])

  const runGeneration = async (job: GenerationCheckpoint, usedSignatures: string[] = []) => {
    setError(''); setDone(false); setProgress(Math.max(1, Math.round((job.completedSheets / job.totalSheets) * 100)))
    try { await saveGenerationCheckpoint(job, tenantId) } catch { /* The worker can still finish in memory. */ }
    const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' })
    let checkpointChain = Promise.resolve()
    const finishWithError = (message: string) => { setProgress(0); setError(message); setResumeJob(job); worker.terminate() }
    worker.onmessage = (event: MessageEvent<{ type: 'progress'; percent: number } | { type: 'chunk'; blocks: BingoBlock[]; completedSheets: number; nextPage: number; nextBlockNumber: number } | { type: 'complete'; completedSheets: number } | { type: 'error'; message: string }>) => {
      const result = event.data
      if (result.type === 'progress') setProgress(Math.max(1, result.percent))
      if (result.type === 'chunk') {
        const decoratedBlocks = decorateBlocks(result.blocks)
        setGenerated((current) => [...current, ...decoratedBlocks])
        onGenerated(decoratedBlocks, 'checkpoint')
        checkpointChain = checkpointChain.then(async () => {
          await persistGenerationChunk(decoratedBlocks, tenantId)
          await saveGenerationCheckpoint({ ...job, completedSheets: result.completedSheets, nextPage: result.nextPage, nextBlockNumber: result.nextBlockNumber, updatedAt: new Date().toISOString() }, tenantId)
        }).catch((checkpointError) => { finishWithError(checkpointError instanceof Error ? checkpointError.message : 'No se pudo guardar el progreso de generación.') })
      }
      if (result.type === 'complete') {
        void checkpointChain.then(async () => {
          await clearGenerationCheckpoint(job.campaign, tenantId)
          onGenerated([], 'complete')
          setProgress(100); setDone(true); setResumeJob(null); worker.terminate()
        }).catch((completionError) => finishWithError(completionError instanceof Error ? completionError.message : 'No se pudo finalizar la generación.'))
      }
      if (result.type === 'error') finishWithError(result.message)
    }
    worker.onerror = () => finishWithError('No se pudo continuar el generador en segundo plano. El progreso guardado se puede reanudar.')
    worker.postMessage({ campaign: job.campaign, totalSheets: job.totalSheets - job.completedSheets, startingPage: job.nextPage, startingBlockNumber: job.nextBlockNumber, chunkSheets: GENERATION_CHUNK_SHEETS, usedSignatures })
  }

  const normalizeCampaign = (value: string) => { const base = value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'BPS-2026'; return tenantId ? base + '-' + tenantId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase() : base }
  const generate = () => {
    if (resumeJob) { void resumeGeneration(); return }
    const campaign = normalizeCampaign(code)
    const job: GenerationCheckpoint = { id: 'active', campaign, totalSheets: sheets, completedSheets: 0, nextPage: 1, nextBlockNumber: 1, updatedAt: new Date().toISOString() }
    const usedSignatures = Array.from(new Set(existingBlocks.flatMap((block) => block.sheets.flatMap((sheet) => sheet.cards.map((card) => cardSignature(card.numbers))))))
    setGenerated([]); setResumeJob(null); void runGeneration(job, usedSignatures)
  }
  const resumeGeneration = async () => {
    if (!resumeJob) return
    const stored = await loadPersistedBlocks(tenantId)
    const existing = stored.filter((block) => block.campaign === resumeJob.campaign)
    const usedSignatures = Array.from(new Set(existing.flatMap((block) => block.sheets.flatMap((sheet) => sheet.cards.map((card) => cardSignature(card.numbers))))))
    setCode(resumeJob.campaign); setSheets(resumeJob.totalSheets); setGenerated(decorateBlocks(existing)); void runGeneration(resumeJob, usedSignatures)
  }
  const downloadZip = async () => { if (!generated.length) return; const totalSheets = generated.reduce((total, block) => total + block.pages, 0); if (totalSheets > MAX_BULK_ZIP_SHEETS) { setError(`Este lote tiene ${totalSheets.toLocaleString('es-EC')} hojas. Descarga los bloques individualmente desde Inventario para evitar un archivo ZIP demasiado grande.`); return } const blob = await createBlocksZip(generated); triggerDownload(blob, `${code.toUpperCase()}-bloques.zip`) }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">NUEVA GENERACIÓN</div><h1>Diseña tu próximo lote.</h1><p className="muted">Cada hoja tendrá cuatro cartones únicos de 5×5 con centro libre.</p></div><div className="secure-badge"><Icon name="check" /> Motor real de cartones activos</div></div><div className="generator-layout"><section className="panel form-panel"><div className="panel-heading"><div><h3>Configuración del lote</h3><p>Define cómo se identificará y distribuirá.</p></div><span className="step-badge">01 / 02</span></div><label>Nombre del lote<input value={code} onChange={e => setCode(e.target.value)} /></label><label>Cantidad de hojas<div className="number-control"><button onClick={() => setSheets(Math.max(100, sheets - 100))}>−</button><input type="number" min="100" max="200000" value={sheets} onChange={e => setSheets(Math.min(200000, Math.max(100, Number(e.target.value))))} /><button onClick={() => setSheets(Math.min(200000, sheets + 100))}>+</button></div><small className="helper">Mínimo 100 · máximo 200.000 · se crearán {sheets.toLocaleString('es-EC')} hojas / {(sheets * 4).toLocaleString('es-EC')} cartones</small></label><div className="two-fields"><label>Hojas por bloque<input value="40 hojas" disabled /></label><label>Formato<input value="5 × 5 · 75 bolillas" disabled /></label></div><div className="generator-details"><div className="eyebrow">DATOS DE IMPRESIÓN OPCIONALES</div><h3>Completa la información del lote</h3><p className="muted">Los cartones conservan sus números; estos datos quedan vacíos hasta que los completes.</p><div className="two-fields"><label>Fecha<input type="date" value={gameDate} onChange={e => setGameDate(e.target.value)} /></label><label>Encabezado<input value={header} onChange={e => setHeader(e.target.value)} placeholder="Ej. Bingo Parroquial 2026" /></label></div><label>Banner de encabezado<input type="file" accept="image/png,image/jpeg,image/webp" onChange={loadBanner} /><small className="helper">Se aplicará como encabezado visual en todas las hojas PDF de este lote. Máximo 8 MB.</small></label>{banner && <div className="banner-uploaded"><img src={banner} alt="Vista previa del banner" /><button className="ghost compact" onClick={() => setBanner("")}>Quitar banner</button></div>}<label>Texto del centro<input value={freeLabel} onChange={e => setFreeLabel(e.target.value)} placeholder="LIBRE" /><small className="helper">Se imprime en la línea superior del centro; debajo aparece el identificador único del cartón.</small></label><label>Plan de premios<textarea value={prizePlan} onChange={e => setPrizePlan(e.target.value)} placeholder="Ej. Línea $25 · Bingo $100 · Pozo $500" rows={3} /></label><fieldset className="pattern-checklist"><legend>Patrones que se jugarán</legend><div className="pattern-checklist-grid">{patternOptions.map(pattern => <label className="pattern-check-option" key={pattern.id}><input type="checkbox" checked={selectedPatternIds.includes(pattern.id)} onChange={event => setSelectedPatternIds(current => event.target.checked ? [...current, pattern.id] : current.filter(id => id !== pattern.id))} /><PatternIcon pattern={pattern} /><span><b>{pattern.name}</b><small>{pattern.group}</small></span></label>)}</div><small className="helper">Marca uno o varios patrones. Se imprimirán ordenados en el panel central de cada hoja PDF.</small></fieldset><div className="two-fields"><label>Marca de agua<input value={watermarkText} onChange={e => setWatermarkText(e.target.value)} placeholder="Ej. Distribuidor Norte" /></label><label>Opacidad<input type="number" min="0.03" max="0.30" step="0.01" value={watermarkOpacity} onChange={e => setWatermarkOpacity(Math.min(0.30, Math.max(0.03, Number(e.target.value))))} /></label></div><label>Posición de la marca<select value={watermarkPosition} onChange={e => setWatermarkPosition(e.target.value as NonNullable<BingoBlock['watermark']>['position'])}><option value="top-left">Arriba izquierda</option><option value="top-right">Arriba derecha</option><option value="bottom-left">Abajo izquierda</option><option value="bottom-right">Abajo derecha</option></select></label><label>Notas del lote<textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Información adicional para distribución o auditoría" rows={2} /></label></div><div className="option-row"><div className="toggle active"><span /></div><div><b>Evitar cartones duplicados</b><small>Validación activa durante la generación</small></div></div><div className="option-row"><div className="toggle active"><span /></div><div><b>Crear archivos por bloque</b><small>PDF, ZIP y manifiesto CSV/JSON</small></div></div>{error && <div className="error-box">{error}</div>}<button className="primary wide" onClick={generate} disabled={progress > 0 && progress < 100}>{progress > 0 && progress < 100 ? 'Generando cartones…' : done ? 'Generación completada' : 'Generar lote real'} <Icon name={done ? 'check' : 'arrow'} /></button>{done && <div className="download-actions"><button className="ghost" onClick={downloadZip}><Icon name="download" /> {generated.reduce((total, block) => total + block.pages, 0) > MAX_BULK_ZIP_SHEETS ? 'Descargar por bloques' : 'Descargar ZIP'}</button><button className="ghost" onClick={() => triggerDownload(new Blob([blocksToJson(generated)], { type: 'application/json' }), `${code.toUpperCase()}-manifest.json`)}>JSON</button></div>}</section><section className="panel preview-panel"><div className="panel-heading"><div><h3>Vista previa</h3><p>Así se verá una hoja de distribución.</p></div><span className="preview-tag">PDF / ZIP</span></div><div className="sheet-preview"><div className="sheet-head"><div className="sheet-brand">{banner ? <img src={banner} alt="Banner del lote" /> : <b>{header || "BINGO PROMAX STUDIO"}</b>}</div><span>BLOQUE {code.toUpperCase()}-001</span></div><div className="mini-cards">{[0,1,2,3].map(i => <MiniCard key={i} offset={i * 3} freeLabel={freeLabel || 'LIBRE'} />)}</div><div className="sheet-foot"><span>4 cartones · centro {freeLabel.trim() || 'LIBRE'}</span><span>Hoja 1 de {sheets.toLocaleString('es-EC')}</span></div></div>{progress > 0 && <div className="progress-box"><div><b>{progress === 100 ? 'Lote listo para descargar' : 'Generando hojas…'}</b><span>{progress}% completado</span></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div></div>}<div className="generation-note"><Icon name="lock" /><span>La generación se ejecuta en un trabajador independiente para mantener la interfaz disponible. Los lotes grandes se descargan por bloque para proteger la memoria del navegador.</span></div></section></div><div className="next-step"><span><Icon name="check" /> {done ? `${generated.length} bloques creados correctamente` : 'Generación lista para ejecutar'}</span><button className="text-button" onClick={() => setView('blocks')}>Ver mis bloques <Icon name="arrow" /></button></div></div>
}

function MiniCard({ offset, freeLabel = 'LIBRE' }: { offset: number; freeLabel?: string }) { return <div className="mini-card"><div className="mini-title"><span>B</span><span>I</span><span>N</span><span>G</span><span>O</span></div>{Array.from({ length: 25 }, (_, i) => <span key={i} className={i === 12 ? 'free' : ''}>{i === 12 ? freeLabel : ((i * 7 + offset * 3) % 74) + 1}</span>)}</div> }

function LegacyBlocks({ blocks: initialBlocks, setView, onUpdate }: { blocks: BingoBlock[]; setView: (view: View) => void; onUpdate?: (code: string, patch: Partial<BingoBlock>) => void }) {
  const [blocks, setBlocks] = useState(initialBlocks)
  const [downloading, setDownloading] = useState('')
  const applyUpdate = (code: string, patch: Partial<BingoBlock>) => { setBlocks(current => current.map(block => block.code === code ? { ...block, ...patch } : block)); if (onUpdate) onUpdate(code, patch); else { try { const stored: BingoBlock[] = JSON.parse(localStorage.getItem('bps-blocks') ?? '[]'); localStorage.setItem('bps-blocks', JSON.stringify(stored.map(block => block.code === code ? { ...block, ...patch } : block))) } catch { /* storage unavailable */ } } }
  const download = async (block: BingoBlock) => { setDownloading(block.code); triggerDownload(new Blob([createBlockPdf(block)], { type: 'application/pdf' }), `${block.code}.pdf`); applyUpdate(block.code, { status: 'Descargado' }); appendAudit('DESCARGA_BLOQUE', `Bloque ${block.code} descargado`); window.setTimeout(() => setDownloading(''), 700) }
  const markDelivered = (block: BingoBlock) => { const distributor = window.prompt('¿A qué distribuidor o vendedor se entregó este bloque?', block.distributor ?? ''); if (distributor === null) return; const recipient = distributor.trim() || 'Sin asignar'; applyUpdate(block.code, { status: 'Entregado', distributor: recipient, deliveredAt: new Date().toISOString() }); appendAudit('ENTREGA_BLOQUE', `Bloque ${block.code} entregado a ${recipient}`) }
  const downloadAll = async () => { if (!blocks.length) return; setDownloading('all'); const blob = await createBlocksZip(blocks); triggerDownload(blob, 'bingo-promax-studio-bloques.zip'); setDownloading('') }
  const totalSheets = blocks.reduce((total, block) => total + block.pages, 0)
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">DISTRIBUCIÓN</div><h1>Bloques bajo control.</h1><p className="muted">Cada bloque contiene hasta 40 hojas y 160 cartones listos para entregar.</p></div><div className="game-buttons"><button className="ghost" onClick={downloadAll} disabled={!blocks.length || downloading !== ''}><Icon name="download" /> {downloading === 'all' ? 'Preparando ZIP…' : 'Descargar todo'}</button><button className="primary" onClick={() => setView('generator')}><Icon name="plus" /> Nuevo lote</button></div></div><div className="stats-grid compact-stats"><StatCard label="Bloques disponibles" value={String(blocks.length)} detail="Listos para descargar" accent="#f5c84b" icon="layers" /><StatCard label="Hojas en inventario" value={totalSheets.toLocaleString('es-EC')} detail="40 hojas por bloque" accent="#6ee7d1" icon="grid" /><StatCard label="Cartones distribuidos" value={(blocks.filter(block => block.status === 'Entregado').reduce((total, block) => total + block.pages, 0) * 4).toLocaleString('es-EC')} detail="Marcados como entregados" accent="#bda1ff" icon="download" /></div><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">INVENTARIO DE DISTRIBUCIÓN</div><h3>Todos los bloques</h3></div><span className="preview-tag">{blocks.length ? 'GENERACIÓN LOCAL' : 'SIN LOTES'}</span></div>{blocks.length ? <div className="table-wrap"><table><thead><tr><th>Bloque</th><th>Rango de hojas</th><th>Contenido</th><th>Creado</th><th>Distribuidor</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{blocks.map(block => <tr key={block.code}><td><b className="code-cell">{block.code}</b></td><td>{block.range}</td><td>{block.pages} hojas <span className="muted-inline">· {block.pages * 4} cartones</span></td><td>{new Date(block.createdAt).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{block.distributor ?? 'Sin asignar'}{block.deliveredAt && <small className="table-subline">{new Date(block.deliveredAt).toLocaleDateString('es-EC')}</small>}</td><td><span className={`status ${block.status === 'Entregado' ? 'entregado' : 'listo'}`}>{block.status}</span></td><td><div className="table-actions"><button className="icon-button" title="Descargar PDF" onClick={() => download(block)}><Icon name="download" /></button>{block.status !== 'Entregado' && <button className="ghost compact" onClick={() => markDelivered(block)}>Entregar</button>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><span>▤</span><b>Aún no tienes bloques generados</b><p>Genera tu primer lote para ver aquí las hojas y sus archivos.</p><button className="primary" onClick={() => setView('generator')}>Crear primer lote <Icon name="arrow" /></button></div>}</section></div>
}

function DeliveryModal({ block, distributor, notes, setDistributor, setNotes, onClose, onConfirm }: { block: BingoBlock; distributor: string; notes: string; setDistributor: (value: string) => void; setNotes: (value: string) => void; onClose: () => void; onConfirm: () => void }) { return <div className="modal-backdrop"><section className="delivery-modal"><div className="panel-heading"><div><div className="eyebrow">REGISTRO DE ENTREGA</div><h3>Confirmar distribución</h3><p>Asigna el bloque a un distribuidor o vendedor.</p></div><button className="icon-button" onClick={onClose}>×</button></div><div className="delivery-summary"><b>{block.code}</b><span>{block.pages} hojas · {block.pages * 4} cartones</span></div><label>Distribuidor o vendedor<input autoFocus value={distributor} onChange={event => setDistributor(event.target.value)} placeholder="Ej. Distribución Norte" /></label><label>Notas de entrega <small>opcional</small><textarea value={notes} onChange={event => setNotes(event.target.value)} placeholder="Ej. Entregado en bodega principal" /></label><div className="editor-actions"><button className="ghost" onClick={onClose}>Cancelar</button><button className="primary" disabled={!distributor.trim()} onClick={onConfirm}><Icon name="check" /> Confirmar entrega</button></div></section></div> }


function Blocks({ blocks: initialBlocks, setView, onUpdate, onDelete, member }: { blocks: BingoBlock[]; setView: (view: View) => void; onUpdate?: (code: string, patch: Partial<BingoBlock>) => void; onDelete?: (code: string) => Promise<void> | void; member: StudioMember | null }) { const [blocks, setBlocks] = useState(initialBlocks); const [downloading, setDownloading] = useState(''); const [deleting, setDeleting] = useState(''); const [query, setQuery] = useState(''); const [statusFilter, setStatusFilter] = useState<'Todos' | BingoBlock['status']>('Todos'); const [distributorFilter, setDistributorFilter] = useState('Todos'); const [deliveryBlock, setDeliveryBlock] = useState<BingoBlock | null>(null); const [deliveryDistributor, setDeliveryDistributor] = useState(''); const [deliveryNotes, setDeliveryNotes] = useState(''); const canDelete = member?.role === 'developer' || member?.role === 'admin'; const applyUpdate = (code: string, patch: Partial<BingoBlock>) => { setBlocks(current => current.map(block => block.code === code ? { ...block, ...patch } : block)); if (onUpdate) onUpdate(code, patch); else { try { const stored: BingoBlock[] = JSON.parse(localStorage.getItem('bps-blocks') ?? '[]'); localStorage.setItem('bps-blocks', JSON.stringify(stored.map(block => block.code === code ? { ...block, ...patch } : block))) } catch { /* storage unavailable */ } } }; const download = (block: BingoBlock) => { setDownloading(block.code); triggerDownload(new Blob([createBlockPdf(block)], { type: 'application/pdf' }), `${block.code}.pdf`); applyUpdate(block.code, { status: 'Descargado' }); appendAudit('DESCARGA_BLOQUE', `Bloque ${block.code} descargado`); window.setTimeout(() => setDownloading(''), 700) }; const remove = async (block: BingoBlock) => { if (!canDelete || !window.confirm(`¿Eliminar el bloque ${block.code}? Esta acción quitará sus hojas y cartones del inventario.`)) return; setDeleting(block.code); try { if (onDelete) await onDelete(block.code); else { setBlocks(current => current.filter(item => item.code !== block.code)); const stored: BingoBlock[] = JSON.parse(localStorage.getItem('bps-blocks') ?? '[]'); localStorage.setItem('bps-blocks', JSON.stringify(stored.filter(item => item.code !== block.code))); } setBlocks(current => current.filter(item => item.code !== block.code)); appendAudit('ELIMINAR_BLOQUE', `Bloque ${block.code} eliminado`); } catch (caught) { window.alert(caught instanceof Error ? caught.message : 'No se pudo eliminar el bloque.'); } finally { setDeleting('') } }; const openDelivery = (block: BingoBlock) => { setDeliveryBlock(block); setDeliveryDistributor(block.distributor ?? ''); setDeliveryNotes(block.notes ?? '') }; const confirmDelivery = () => { if (!deliveryBlock || !deliveryDistributor.trim()) return; const recipient = deliveryDistributor.trim(); applyUpdate(deliveryBlock.code, { status: 'Entregado', distributor: recipient, notes: deliveryNotes.trim(), deliveredAt: new Date().toISOString() }); appendAudit('ENTREGA_BLOQUE', `Bloque ${deliveryBlock.code} entregado a ${recipient}`); setDeliveryBlock(null); setDeliveryDistributor(''); setDeliveryNotes('') }; const downloadAll = async () => { if (!blocks.length || blocks.reduce((total, block) => total + block.pages, 0) > MAX_BULK_ZIP_SHEETS) return; setDownloading('all'); const blob = await createBlocksZip(blocks); triggerDownload(blob, 'bingo-promax-studio-bloques.zip'); appendAudit('DESCARGA_LOTE', `${blocks.length} bloques descargados en ZIP`); setDownloading('') }; const distributors = Array.from(new Set(blocks.map(block => block.distributor).filter((value): value is string => Boolean(value)))).sort(); const visibleBlocks = blocks.filter(block => { const normalized = query.trim().toLowerCase(); const matchesQuery = !normalized || [block.code, block.range, block.distributor ?? '', block.notes ?? ''].some(value => value.toLowerCase().includes(normalized)); const matchesStatus = statusFilter === 'Todos' || block.status === statusFilter; const matchesDistributor = distributorFilter === 'Todos' || (block.distributor ?? 'Sin asignar') === distributorFilter; return matchesQuery && matchesStatus && matchesDistributor }); const totalSheets = blocks.reduce((total, block) => total + block.pages, 0); const deliveredSheets = blocks.filter(block => block.status === 'Entregado').reduce((total, block) => total + block.pages, 0); return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">DISTRIBUCIÓN</div><h1>Bloques bajo control.</h1><p className="muted">Cada bloque contiene hasta 40 hojas y 160 cartones listos para entregar.</p></div><div className="game-buttons"><button className="ghost" onClick={downloadAll} disabled={!blocks.length || downloading !== '' || deleting !== '' || totalSheets > MAX_BULK_ZIP_SHEETS} title={totalSheets > MAX_BULK_ZIP_SHEETS ? 'Descarga cada bloque individualmente para este lote grande.' : undefined}><Icon name="download" /> {downloading === 'all' ? 'Preparando ZIP…' : totalSheets > MAX_BULK_ZIP_SHEETS ? 'Descarga por bloques' : 'Descargar todo'}</button><button className="primary" onClick={() => setView('generator')}><Icon name="plus" /> Nuevo lote</button></div></div><div className="stats-grid compact-stats"><StatCard label="Bloques disponibles" value={String(blocks.length)} detail="Listos para descargar" accent="#f5c84b" icon="layers" /><StatCard label="Hojas en inventario" value={totalSheets.toLocaleString('es-EC')} detail="Todos los estados" accent="#6ee7d1" icon="grid" /><StatCard label="Cartones entregados" value={(deliveredSheets * 4).toLocaleString('es-EC')} detail={`${deliveredSheets.toLocaleString('es-EC')} hojas entregadas`} accent="#bda1ff" icon="download" /></div><section className="panel distribution-toolbar"><label><span>Buscar bloque</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Código, rango o nota…" /></label><label><span>Estado</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'Todos' | BingoBlock['status'])}><option>Todos</option><option>Listo</option><option>Descargado</option><option>Entregado</option></select></label><label><span>Distribuidor</span><select value={distributorFilter} onChange={event => setDistributorFilter(event.target.value)}><option>Todos</option>{distributors.map(distributor => <option key={distributor}>{distributor}</option>)}<option>Sin asignar</option></select></label><div className="filter-result"><b>{visibleBlocks.length}</b><span>de {blocks.length} bloques</span></div></section><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">INVENTARIO DE DISTRIBUCIÓN</div><h3>Todos los bloques</h3></div><span className="preview-tag">{blocks.length ? 'GENERACIÓN LOCAL' : 'SIN LOTES'}</span></div>{visibleBlocks.length ? <div className="table-wrap"><table><thead><tr><th>Bloque</th><th>Rango de hojas</th><th>Contenido</th><th>Creado</th><th>Distribuidor</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{visibleBlocks.map(block => <tr key={block.code}><td><b className="code-cell">{block.code}</b></td><td>{block.range}</td><td>{block.pages} hojas <span className="muted-inline">· {block.pages * 4} cartones</span></td><td>{new Date(block.createdAt).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{block.distributor ?? 'Sin asignar'}{block.deliveredAt && <small className="table-subline">{new Date(block.deliveredAt).toLocaleDateString('es-EC')}{block.notes ? ` · ${block.notes}` : ''}</small>}</td><td><span className={`status ${block.status === 'Entregado' ? 'entregado' : 'listo'}`}>{block.status}</span></td><td><div className="table-actions"><button className="icon-button" title="Descargar PDF" onClick={() => download(block)} disabled={deleting !== ''}><Icon name="download" /></button>{block.status !== 'Entregado' && <button className="ghost compact" onClick={() => setView('network')} disabled={deleting !== ''}>Transferir</button>}{canDelete && <button className="icon-button danger" title="Eliminar bloque" onClick={() => void remove(block)} disabled={deleting !== ''}><span>{deleting === block.code ? '…' : '×'}</span></button>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><span>▤</span><b>{blocks.length ? 'No hay coincidencias' : 'Aún tienes bloques generados'}</b><p>{blocks.length ? 'Prueba con otro código, estado o distribuidor.' : 'Genera tu primer lote para ver aquí las hojas y sus archivos.'}</p>{!blocks.length && <button className="primary" onClick={() => setView('generator')}>Crear primer lote <Icon name="arrow" /></button>}</div>}</section></div> }
function PatternEditor({ initial, onClose, onSave }: { initial: Pattern; onClose: () => void; onSave: (pattern: Pattern) => void }) { const [draft, setDraft] = useState(initial); const toggleCell = (index: number) => setDraft(current => ({ ...current, cells: current.cells.includes(index) ? current.cells.filter(cell => cell !== index) : [...current.cells, index].sort((a, b) => a - b) })); return <div className="modal-backdrop"><section className="pattern-editor"><div className="panel-heading"><div><div className="eyebrow">EDITOR VISUAL 5 × 5</div><h3>{initial.id ? 'Editar patrón' : 'Crear patrón'}</h3><p>Selecciona las casillas que deben completarse.</p></div><button className="icon-button" onClick={onClose}>×</button></div><div className="editor-layout"><div className="editor-grid">{Array.from({ length: 25 }, (_, index) => <button className={draft.cells.includes(index) ? 'selected' : ''} key={index} onClick={() => toggleCell(index)}>{index === 12 ? '★' : ''}</button>)}</div><div className="editor-fields"><label>Nombre<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>Grupo<select value={draft.group} onChange={event => setDraft({ ...draft, group: event.target.value })}><option>Clásicos</option><option>Letras</option><option>Números</option><option>Especiales</option><option>Personalizados</option></select></label><label>Color<input type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label><label>Descripción<textarea value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label><div className="editor-actions"><button className="ghost" onClick={onClose}>Cancelar</button><button className="primary" disabled={!draft.name.trim() || draft.cells.length === 0} onClick={() => onSave({ ...draft, id: draft.id || `${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}` })}>Guardar patrón</button></div></div></div></section></div> }
function PatternsCatalog({ tenantId }: { tenantId?: string }) {
  const [patterns, setPatterns] = useState<Pattern[]>(readPatternCatalog)
  const [editing, setEditing] = useState<Pattern | null>(null)
  useEffect(() => {
    let active = true
    void loadStudioPatterns(tenantId).then(remote => {
      if (!active || !remote.length) return
      const merged = mergePatternCatalog(remote)
      localStorage.setItem('bps-patterns', JSON.stringify(merged))
      setPatterns(merged)
    }).catch(() => { /* Local catalog remains available offline. */ })
    return () => { active = false }
  }, [tenantId])
  const update = (items: Pattern[]) => { setPatterns(items); localStorage.setItem('bps-patterns', JSON.stringify(items)); void syncStudioPatterns(items, tenantId).catch(() => { /* Local catalog remains available offline. */ }) }
  const toggle = (id: string) => update(patterns.map(item => item.id === id ? { ...item, active: !item.active } : item))
  const save = (pattern: Pattern) => { const next = patterns.some(item => item.id === pattern.id) ? patterns.map(item => item.id === pattern.id ? pattern : item) : [...patterns, pattern]; update(next); setEditing(null) }
  const remove = async (pattern: Pattern) => { if (!pattern.id || !window.confirm(`¿Eliminar el patrón ${pattern.name}?`)) return; try { await deleteStudioPattern(pattern.id, tenantId); const next = patterns.filter(item => item.id !== pattern.id); setPatterns(next); localStorage.setItem('bps-patterns', JSON.stringify(next)); } catch (caught) { window.alert(caught instanceof Error ? caught.message : 'No se pudo eliminar el patrón.') } }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">BIBLIOTECA DE FIGURAS</div><h1>Administra tus patrones.</h1><p className="muted">Selecciona las figuras que podrás usar en cada partida.</p></div><button className="primary" onClick={() => setEditing({ id: '', name: '', description: 'Patrón personalizado creado por el estudio.', group: 'Personalizados', color: '#f5c84b', cells: [12], active: false })}><Icon name="plus" /> Crear patrón</button></div><div className="pattern-summary"><div><span className="summary-orb">✦</span><div><b>{patterns.filter(p => p.active).length} patrones habilitados</b><small>{patterns.length} patrones disponibles</small></div></div><div className="summary-chips"><span>● {patterns.filter(p => p.group === 'Clásicos').length} clásicos</span><span>✦ {patterns.filter(p => p.group === 'Letras').length} letras</span><span>⌘ {patterns.filter(p => p.group === 'Números').length} números</span></div></div><div className="pattern-grid">{patterns.map(pattern => <PatternCard key={pattern.id} pattern={pattern} onToggle={() => toggle(pattern.id)} onEdit={() => setEditing(pattern)} onDelete={() => void remove(pattern)} />)}</div>{editing && <PatternEditor initial={editing} onClose={() => setEditing(null)} onSave={save} />}</div>
}
function HeadersManager({ tenantId }: { tenantId?: string }) {
  const [headers, setHeaders] = useState<StudioHeader[]>([])
  const [name, setName] = useState('Encabezado principal')
  const [content, setContent] = useState('BINGO PROMAX · Cartones oficiales')
  const [error, setError] = useState('')
  const refresh = async () => { if (!tenantId) return; try { setHeaders(await loadStudioHeaders(tenantId)) } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudieron cargar los encabezados.') } }
  useEffect(() => { void refresh() }, [tenantId])
  const save = async () => { if (!tenantId || !name.trim()) return; try { await saveStudioHeader({ tenantId, name, content }); setName('Encabezado principal'); setContent('BINGO PROMAX · Cartones oficiales'); await refresh() } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar el encabezado.') } }
  const remove = async (header: StudioHeader) => { if (!window.confirm(`¿Eliminar ${header.name}?`)) return; try { await deleteStudioHeader(header.id); await refresh() } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo eliminar el encabezado.') } }
  return <section className="panel form-panel"><div className="eyebrow">IDENTIDAD DE DOCUMENTOS</div><h3>Encabezados propios</h3><p className="muted">Cada administrador controla sus encabezados para PDFs y partidas.</p><div className="form-stack"><label>Nombre<input value={name} onChange={event => setName(event.target.value)} /></label><label>Contenido<textarea value={content} onChange={event => setContent(event.target.value)} /></label><button className="primary" onClick={() => void save()}><Icon name="plus" /> Guardar encabezado</button>{error && <div className="error-box">{error}</div>}{headers.map(header => <div className="user-row" key={header.id}><div><b>{header.name}</b><span>{header.content}</span></div><button className="icon-button danger" onClick={() => void remove(header)} title="Eliminar encabezado">×</button></div>)}</div></section>
}
function Patterns({ tenantId }: { tenantId?: string }) { return <><PatternsCatalog tenantId={tenantId} /><div className="page-content"><HeadersManager tenantId={tenantId} /></div></> }
function PatternCard({ pattern, onToggle, onEdit, onDelete }: { pattern: Pattern; onToggle: () => void; onEdit: () => void; onDelete: () => void }) { return <article className={`pattern-card ${pattern.active ? 'pattern-active' : ''}`}><div className="pattern-card-head"><PatternIcon pattern={pattern} /><span className={`pattern-status ${pattern.active ? 'enabled' : ''}`}>{pattern.active ? 'En juego' : 'Inactivo'}</span></div><h3>{pattern.name}</h3><p>{pattern.description}</p><div className="pattern-actions"><button className={`outline-action ${pattern.active ? 'gold' : ''}`} onClick={onToggle}>{pattern.active ? 'Deshabilitar' : 'Habilitar'}</button><button className="icon-button" onClick={onEdit} title="Editar patrón">⌕</button><button className="icon-button danger" onClick={onDelete} title="Eliminar patrón">×</button></div><footer><span>{pattern.group}</span><span>{pattern.active ? 'Disponible' : 'Pausado'}</span></footer></article> }
function PatternIcon({ pattern }: { pattern: Pattern }) { return <div className="pattern-icon" style={{ '--pattern-color': pattern.color } as CSSProperties}>{Array.from({ length: 25 }, (_, i) => <i className={pattern.cells.includes(i) ? 'on' : ''} key={i} />)}</div> }

function Games({ selectedPatterns, setSelectedPatterns, blocks }: { selectedPatterns: string[]; setSelectedPatterns: (ids: string[]) => void; blocks: BingoBlock[] }) { const [started, setStarted] = useState(false); const [drawn, setDrawn] = useState<number[]>([]); const [winner, setWinner] = useState(''); const activePatterns = seedPatterns.filter(p => p.active); const card = blocks[0]?.sheets[0]?.cards[0] ?? demoCard; const togglePattern = (id: string) => setSelectedPatterns(selectedPatterns.includes(id) ? selectedPatterns.filter(p => p !== id) : [...selectedPatterns, id]); const draw = (n: number) => { if (!started || drawn.includes(n)) return; const next = [...drawn, n]; setDrawn(next); const drawnSet = new Set(next); const completed = activePatterns.filter(pattern => selectedPatterns.includes(pattern.id) && isPatternComplete(card, pattern.cells, drawnSet)); if (completed.length) setWinner(completed.map(pattern => pattern.name).join(' · ')) }; const reset = () => { setDrawn([]); setStarted(false); setWinner('') }; return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">PARTIDA ACTUAL <span className="live-pill">● {started ? 'EN JUEGO' : 'LISTA'}</span></div><h1>{started ? 'Partida en movimiento.' : 'Prepara una nueva partida.'}</h1><p className="muted">Elige los patrones y registra cada bolilla desde el teclado visual.</p></div><div className="game-buttons"><button className="ghost" onClick={reset}>Reiniciar</button><button className="primary" onClick={() => setStarted(true)}><Icon name="play" /> {started ? 'Partida activa' : 'Comenzar partida'}</button></div></div>{winner && <div className="winner-alert"><span>🏆</span><div><b>Patrón completado: {winner}</b><small>La tarjeta de demostración {card.id} cumple la modalidad seleccionada.</small></div><button className="ghost" onClick={() => setWinner('')}>Ocultar</button></div>}<div className="game-layout"><section className="panel game-board"><div className="game-board-head"><div><div className="eyebrow">CONTROL DE BOLILLAS</div><h3>Registrar nueva bolilla</h3></div><span className="no-duplicates"><Icon name="check" /> Sin duplicados</span></div><div className="latest-row"><div className="last-ball"><small>ÚLTIMA BOLILLA</small><b>{drawn.at(-1) ?? '—'}</b><span>{drawn.length ? 'Registrada ahora' : 'Esperando inicio'}</span></div><div className="draw-history"><div className="history-title"><b>Historial de bolillas</b><span>{drawn.length} / 75</span></div><div className="history-balls">{drawn.slice(-12).reverse().map(n => <i key={n}>{n}</i>)}</div><div className="progress-track"><div style={{ width: `${(drawn.length / 75) * 100}%` }} /></div></div></div><div className="ball-grid">{Array.from({ length: 75 }, (_, i) => i + 1).map(n => <button className={drawn.includes(n) ? 'drawn' : ''} key={n} onClick={() => draw(n)} disabled={!started}>{n}</button>)}</div></section><aside className="panel selected-patterns"><div className="eyebrow">PATRONES EN JUEGO</div><h3>Selecciona las figuras</h3><p>Se verificarán automáticamente con cada bolilla.</p><div className="pattern-select-list">{activePatterns.map(pattern => <button className={`select-pattern ${selectedPatterns.includes(pattern.id) ? 'chosen' : ''}`} key={pattern.id} onClick={() => togglePattern(pattern.id)}><PatternIcon pattern={pattern} /><span><b>{pattern.name}</b><small>{pattern.group}</small></span><span className="check-circle">{selectedPatterns.includes(pattern.id) ? '✓' : ''}</span></button>)}</div><div className="selected-count">{selectedPatterns.length} patrones seleccionados · {blocks.length ? 'cartones cargados' : 'modo demostración'}</div></aside></div></div> }

function WinnerPanel({ winner, drawn, visible, onHide, onShow }: { winner: Array<{ pattern: Pattern; cards: BingoCard[] }>; drawn: number[]; visible: boolean; onHide: () => void; onShow: () => void }) {
  const totalCards = winner.reduce((total, result) => total + result.cards.length, 0)
  if (!visible) return <div className="winner-alert winner-alert-collapsed"><span>🏆</span><div><b>Ganadores guardados</b><small>{totalCards.toLocaleString('es-EC')} cartón(es) en {winner.length} patrón(es). Puedes volver a revisarlos.</small></div><button className="ghost" onClick={onShow}>↗ Mostrar tabla ganadora</button></div>
  return <div className="winner-alert winner-alert-expanded"><span>🏆</span><div><b>Ganadores detectados · {drawn.at(-1)}</b><small>{totalCards.toLocaleString('es-EC')} cartón(es) ganadores en {winner.length} patrón(es).</small><div className="winner-results">{winner.map(result => <section key={result.pattern.id}><strong>{result.pattern.name} · {result.cards.length.toLocaleString('es-EC')} ganador(es)</strong><div className="winner-card-list">{result.cards.map(card => <article className="winner-card" key={`${result.pattern.id}-${card.id}`}><b>{card.id}</b><small>{result.pattern.name}</small><div className="winner-card-grid">{card.numbers.flatMap((row, rowIndex) => row.map((value, columnIndex) => <span className={value === 0 ? 'free' : ''} key={`${rowIndex}-${columnIndex}`}>{value === 0 ? 'LIBRE' : value}</span>))}</div></article>)}</div></section>)}</div></div><button className="ghost" onClick={onHide}>Ocultar</button></div>
}

function CompleteGames({ selectedPatterns, setSelectedPatterns, blocks, tenantId, member }: { selectedPatterns: string[]; setSelectedPatterns: (ids: string[]) => void; blocks: BingoBlock[]; tenantId?: string; member: StudioMember | null }) {
  const [started, setStarted] = useState(false)
  const [drawn, setDrawn] = useState<number[]>([])
  const [search, setSearch] = useState('')
  const [winner, setWinner] = useState<Array<{ pattern: Pattern; cards: BingoCard[] }> | null>(null)
  const [winnerVisible, setWinnerVisible] = useState(true)
  const [winnerHistory, setWinnerHistory] = useState<{ pattern: string; count: number; ball: number }[]>([])
  const [gameId, setGameId] = useState(() => localStorage.getItem('bps-current-game') ?? crypto.randomUUID())
  const [gameHydrated, setGameHydrated] = useState(false)
  const [gameName, setGameName] = useState('Partida Studio')
  const [gameDate, setGameDate] = useState(new Date().toISOString().slice(0, 10))
  const [prizePlan, setPrizePlan] = useState<Array<{ name: string; amount: string }>>([{ name: 'Bingo', amount: '' }])
  const [newGameOpen, setNewGameOpen] = useState(false)
  const [newGameBusy, setNewGameBusy] = useState(false)
  const [activeBlockCodes, setActiveBlockCodes] = useState<string[]>(() => blocks.map(block => block.code))
  const [patternCatalog, setPatternCatalog] = useState<Pattern[]>(readPatternCatalog)
  const buildGameSnapshot = (id = gameId, status: StudioGame['status'] = started ? 'running' : 'ready'): StudioGame => ({
    id,
    name: gameName,
    date: gameDate,
    prize: prizePlan.map(item => `${item.name}: ${item.amount}`).filter(Boolean).join(' · '),
    status,
    activePatternIds: selectedPatterns,
    drawnNumbers: drawn,
    winnerHistory,
    notes: 'Partida administrada desde Bingo ProMax Studio.',
    activeBlockCodes,
    prizePlan,
  })
  useEffect(() => {
    let active = true
    void Promise.all([loadStudioGame(tenantId), loadStudioPatterns(tenantId)]).then(([remote, remotePatterns]) => {
      if (!active) return
      setPatternCatalog(mergePatternCatalog(remotePatterns))
      if (remote) {
        setGameId(remote.id)
        localStorage.setItem('bps-current-game', remote.id)
        setStarted(remote.status === 'running')
        setDrawn(remote.drawnNumbers)
        setWinnerHistory(remote.winnerHistory)
        setGameName(remote.name)
        setGameDate(remote.date || new Date().toISOString().slice(0, 10))
        setPrizePlan(remote.prizePlan.length ? remote.prizePlan : [{ name: 'Bingo', amount: '' }])
        setActiveBlockCodes(remote.activeBlockCodes.length ? remote.activeBlockCodes : blocks.map(block => block.code))
        if (remote.activePatternIds.length) setSelectedPatterns(remote.activePatternIds)
      } else {
        try {
          const local = JSON.parse(localStorage.getItem('bps-current-game-state') ?? 'null') as StudioGame | null
          if (local) {
            setGameId(local.id)
            setStarted(local.status === 'running')
            setDrawn(local.drawnNumbers)
            setWinnerHistory(local.winnerHistory)
            if (local.activePatternIds.length) setSelectedPatterns(local.activePatternIds)
          }
        } catch { /* Start a new local game when no saved state exists. */ }
      }
      setGameHydrated(true)
    }).catch(() => {
      if (!active) return
      try {
        const local = JSON.parse(localStorage.getItem('bps-current-game-state') ?? 'null') as StudioGame | null
        if (local) {
          setGameId(local.id)
          setStarted(local.status === 'running')
          setDrawn(local.drawnNumbers)
          setWinnerHistory(local.winnerHistory)
          if (local.activePatternIds.length) setSelectedPatterns(local.activePatternIds)
        }
      } catch { /* Start a new local game when no saved state exists. */ }
      setGameHydrated(true)
    })
    return () => { active = false }
  }, [setSelectedPatterns, tenantId])
  useEffect(() => {
    if (!gameHydrated) return
    const game = buildGameSnapshot()
    localStorage.setItem('bps-current-game', gameId)
    localStorage.setItem('bps-current-game-state', JSON.stringify(game))
    void syncStudioGame(game, tenantId).catch(() => { /* Local game state remains available offline. */ })
  }, [drawn, gameDate, gameHydrated, gameId, gameName, prizePlan, selectedPatterns, started, winnerHistory, activeBlockCodes, tenantId])
  useEffect(() => {
    setActiveBlockCodes(current => current.filter(code => blocks.some(block => block.code === code)))
  }, [blocks])
  // La disponibilidad para una jugada se decide con el visto de esta partida.
  // Por eso el administrador debe poder ver todo su catálogo, incluso patrones
  // que estén pausados en la biblioteca general.
  const activePatterns = patternCatalog
  const canRegisterBalls = member?.role === 'admin'
  const canManageGame = member?.role === 'developer' || member?.role === 'admin'
  const createNewGame = async (mode: 'replace' | 'preserve') => {
    if (!canManageGame || newGameBusy) return
    setNewGameBusy(true)
    try {
      const previous = buildGameSnapshot(gameId, 'finished')
      const archiveKey = `bps-finished-games-${tenantId ?? 'local'}`
      if (mode === 'preserve') {
        let archived: StudioGame[] = []
        try { archived = JSON.parse(localStorage.getItem(archiveKey) ?? '[]') as StudioGame[] } catch { archived = [] }
        localStorage.setItem(archiveKey, JSON.stringify([...archived.filter(item => item.id !== previous.id), previous]))
        await syncStudioGame(previous, tenantId)
      } else {
        await deleteStudioGame(gameId, tenantId)
        localStorage.removeItem(archiveKey)
      }
      const nextId = crypto.randomUUID()
      setGameId(nextId)
      setGameName('Partida Studio')
      setGameDate(new Date().toISOString().slice(0, 10))
      setPrizePlan([{ name: 'Bingo', amount: '' }])
      setActiveBlockCodes(blocks.map(block => block.code))
      setDrawn([])
      setWinner(null)
      setWinnerVisible(false)
      setWinnerHistory([])
      setStarted(false)
      setSearch('')
      setNewGameOpen(false)
      appendAudit(mode === 'preserve' ? 'NUEVA_PARTIDA_CONSERVANDO' : 'NUEVA_PARTIDA_REEMPLAZANDO', mode === 'preserve' ? `Partida ${previous.name} conservada como finalizada` : `Partida ${previous.name} eliminada`)
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : 'No se pudo crear la nueva partida. La partida actual se conserva.')
    } finally {
      setNewGameBusy(false)
    }
  }
  const cards = blocks.filter(block => activeBlockCodes.includes(block.code)).flatMap(block => block.sheets.flatMap(sheet => sheet.cards))
  const gameCards = cards.length ? cards : [demoCard]
  const searchedCard = search.trim() ? gameCards.find(card => card.id.toLowerCase().includes(search.trim().toLowerCase())) : gameCards[0]
  const evaluate = (nextDrawn: number[]) => {
    const drawnSet = new Set(nextDrawn)
    return activePatterns
      .filter(pattern => selectedPatterns.includes(pattern.id))
      .map(pattern => ({ pattern, cards: gameCards.filter(card => isPatternComplete(card, pattern.cells, drawnSet)) }))
      .filter(result => result.cards.length > 0)
  }
  const showHistoricalWinner = (item: { pattern: string; count: number; ball: number }) => {
    const pattern = patternCatalog.find(candidate => candidate.name === item.pattern)
    if (!pattern) return
    const cards = gameCards.filter(card => isPatternComplete(card, pattern.cells, new Set(drawn)))
    if (!cards.length) return
    setWinner([{ pattern, cards }])
    setWinnerVisible(true)
  }
  const draw = (number: number) => {
    if (!canRegisterBalls || !started || drawn.includes(number)) return
    const next = [...drawn, number]
    setDrawn(next)
    const result = evaluate(next)
    if (result.length) {
      setWinner(result)
      setWinnerVisible(true)
      setWinnerHistory(history => {
        const additions = result.filter(item => !history.some(previous => previous.pattern === item.pattern.name && previous.ball === number)).map(item => ({ pattern: item.pattern.name, count: item.cards.length, ball: number }))
        return additions.length ? [...history, ...additions] : history
      })
    }
  }
  const reset = () => { setDrawn([]); setStarted(false); setWinner(null); setWinnerVisible(false); setWinnerHistory([]) }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">PARTIDA ACTUAL <span className="live-pill">● {started ? 'EN JUEGO' : 'LISTA'}</span></div><h1>{started ? 'Partida en movimiento.' : 'Prepara una nueva partida.'}</h1><p className="muted">Cada bolilla se evalúa contra {gameCards.length.toLocaleString('es-EC')} cartones cargados.</p></div><div className="game-buttons">{canManageGame && <button className="ghost" onClick={() => setNewGameOpen(true)} disabled={newGameBusy}>Nueva partida</button>}<button className="ghost" onClick={reset}>Reiniciar</button><button className="primary" onClick={() => setStarted(true)}><Icon name="play" /> {started ? 'Partida activa' : 'Comenzar partida'}</button></div></div><section className="panel game-config"><div className="panel-heading"><div><div className="eyebrow">CONFIGURACIÓN DE LA PARTIDA</div><h3>Fecha, premios y bloques</h3></div><span className="preview-tag">{activeBlockCodes.length} BLOQUES</span></div><div className="two-fields"><label>Nombre de la partida<input value={gameName} onChange={event => setGameName(event.target.value)} /></label><label>Fecha<input type="date" value={gameDate} onChange={event => setGameDate(event.target.value)} /></label></div><label>Plan de premios<input value={prizePlan.map(item => item.name + (item.amount ? ` · ${item.amount}` : '')).join(' | ')} onChange={event => setPrizePlan(event.target.value.split('|').map(value => { const [name, amount = ''] = value.trim().split('·'); return { name: name.trim(), amount: amount.trim() } }).filter(item => item.name))} placeholder="Bingo · $100 | Línea · $25" /></label><fieldset className="game-block-checklist"><legend>Bloques que se jugarán</legend><div className="game-block-check-grid">{blocks.map(block => <label className={`game-block-check ${activeBlockCodes.includes(block.code) ? "chosen" : ""}`} key={block.code}><input type="checkbox" checked={activeBlockCodes.includes(block.code)} onChange={event => setActiveBlockCodes(current => event.target.checked ? [...current, block.code] : current.filter(code => code !== block.code))} /><span><b>{block.code}</b><small>{block.pages} hojas · {block.pages * 4} cartones</small></span></label>)}</div><small className="helper">Marca los bloques que participan en esta partida. Solo sus cartones se rastrearán y podrán aparecer como ganadores.</small></fieldset><fieldset className="game-pattern-checklist"><legend>Patrones que se jugarán</legend><div className="game-pattern-check-grid">{activePatterns.map(pattern => <label className="game-pattern-check" key={pattern.id}><input type="checkbox" checked={selectedPatterns.includes(pattern.id)} onChange={event => event.target.checked ? setSelectedPatterns([...selectedPatterns, pattern.id]) : setSelectedPatterns(selectedPatterns.filter(id => id !== pattern.id))} /><span><b>{pattern.name}</b><small>{pattern.group}</small></span></label>)}</div><small className="helper">Marca los patrones que se evaluarán durante esta partida.</small></fieldset></section>{winner && <WinnerPanel winner={winner} drawn={drawn} visible={winnerVisible} onHide={() => setWinnerVisible(false)} onShow={() => setWinnerVisible(true)} />}<div className="game-layout"><section className="panel game-board"><div className="game-board-head"><div><div className="eyebrow">CONTROL DE BOLILLAS</div><h3>Registrar nueva bolilla</h3></div><span className="no-duplicates"><Icon name="check" /> Sin duplicados</span></div>{!canRegisterBalls && <div className="success-box">Solo el administrador puede registrar las bolillas en el tablero visual.</div>}<div className="latest-row"><div className="last-ball"><small>ÚLTIMA BOLILLA</small><b>{drawn.at(-1) ?? '—'}</b><span>{drawn.length ? 'Registrada ahora' : 'Esperando inicio'}</span></div><div className="draw-history"><div className="history-title"><b>Historial de bolillas</b><span>{drawn.length} / 75</span></div><div className="history-balls">{drawn.slice(-12).reverse().map(number => <i key={number}>{number}</i>)}</div><div className="progress-track"><div style={{ width: `${(drawn.length / 75) * 100}%` }} /></div></div></div><div className="ball-grid">{Array.from({ length: 75 }, (_, index) => index + 1).map(number => <button className={drawn.includes(number) ? 'drawn' : ''} key={number} onClick={() => draw(number)} disabled={!canRegisterBalls || !started} title={!canRegisterBalls ? 'Solo el administrador puede registrar bolillas' : undefined}>{number}</button>)}</div>{winnerHistory.length > 0 && <div className="winner-history"><div className="eyebrow">VALIDACIONES DE ESTA PARTIDA</div>{winnerHistory.map(item => <button className="winner-history-row winner-history-trigger" type="button" key={`${item.pattern}-${item.ball}`} onClick={() => showHistoricalWinner(item)} title="Mostrar tabla ganadora"><span>✓</span><b>{item.pattern}</b><small>{item.count} ganador(es) · bolilla {item.ball}</small><span className="winner-history-open">↗</span></button>)}</div>}</section><aside className="panel selected-patterns"><div className="eyebrow">PATRONES EN JUEGO</div><h3>Patrones seleccionados</h3><p>Se verificarán contra todos los cartones cargados.</p><div className="pattern-select-list">{activePatterns.map(pattern => <label className={`select-pattern ${selectedPatterns.includes(pattern.id) ? 'chosen' : ''}`} key={pattern.id}><input type="checkbox" checked={selectedPatterns.includes(pattern.id)} onChange={event => event.target.checked ? setSelectedPatterns([...selectedPatterns, pattern.id]) : setSelectedPatterns(selectedPatterns.filter(id => id !== pattern.id))} /><PatternIcon pattern={pattern} /><span><b>{pattern.name}</b><small>{pattern.group}</small></span><span className="check-circle">{selectedPatterns.includes(pattern.id) ? '✓' : ''}</span></label>)}</div><div className="card-search"><label>Buscar cartón<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Ej. BP-2026-001-H000001" /></label>{searchedCard && <div className="searched-card"><div><b>{searchedCard.id}</b><small>{cards.length ? 'Cartón cargado desde el bloque' : 'Cartón de demostración'}</small></div><span>{drawn.length} bolillas</span></div>}</div><div className="selected-count">{selectedPatterns.length} patrones · {gameCards.length.toLocaleString('es-EC')} cartones en juego</div></aside></div>{newGameOpen && <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="new-game-modal"><div className="panel-heading"><div><div className="eyebrow">CONTROL DE PARTIDAS</div><h3>Nueva partida</h3><p>Elige qué hacer con la partida actual antes de comenzar otra.</p></div><button className="icon-button" onClick={() => setNewGameOpen(false)} disabled={newGameBusy}>×</button></div><div className="new-game-options"><button className="new-game-option" onClick={() => void createNewGame("preserve")} disabled={newGameBusy}><span className="new-game-option-icon">↗</span><span><b>Conservar la partida actual</b><small>La partida se marca como finalizada y sus bolillas, ganadores y bloques quedan guardados.</small></span></button><button className="new-game-option danger-option" onClick={() => void createNewGame("replace")} disabled={newGameBusy}><span className="new-game-option-icon">×</span><span><b>Eliminar y reemplazar</b><small>Elimina la partida actual del inventario y crea una nueva desde cero.</small></span></button></div>{newGameBusy && <div className="helper">Guardando la partida actual y preparando la nueva…</div>}<div className="editor-actions"><button className="ghost" onClick={() => setNewGameOpen(false)} disabled={newGameBusy}>Cancelar</button></div></section></div>}</div>
}

function Integration({ blocks, onImport }: { blocks: BingoBlock[]; onImport: (blocks: BingoBlock[]) => void }) { const [message, setMessage] = useState(''); const [error, setError] = useState(''); const exportJson = () => triggerDownload(new Blob([blocksToProMaxJson(blocks)], { type: 'application/json' }), 'bingo-promax-package-v1-1.json'); const exportCsv = () => triggerDownload(new Blob([blocksToProMaxCsv(blocks)], { type: 'text/csv;charset=utf-8' }), 'bingo-promax-package-v1-1.csv'); const importFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const imported = parseProMaxPackage(String(reader.result)); onImport(imported); setError(''); setMessage(`${imported.length} bloques importados y listos para usar.`) } catch (importError) { setMessage(''); setError(importError instanceof Error ? importError.message : 'No se pudo importar el paquete.') } }; reader.readAsText(file); event.target.value = '' }; return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">PUENTE DE DATOS</div><h1>Conecta con ProMax.</h1><p className="muted">Intercambia cartones y bloques con Bingo Control ProMax usando un formato versionado.</p></div><div className="secure-badge"><Icon name="check" /> Esquema de intercambio v1.1</div></div><div className="integration-status"><div className="status-orb">↔</div><div><b>Intercambio seguro por paquete</b><p>Exporta desde Studio e importa el paquete en Bingo Control ProMax. El inventario y la auditoría se sincronizan con la nube cuando Supabase está configurado; el paquete v1.1 sigue siendo el puente controlado hacia ProMax.</p></div><span className="status listo">Preparado</span></div><div className="integration-grid"><section className="panel integration-panel"><div className="eyebrow">EXPORTAR A PROMAX</div><h3>Paquete de cartones</h3><p>Incluye campañas, bloques, hojas, códigos y cartones con el formato real de ProMax.</p><div className="export-actions"><button className="primary" onClick={exportJson} disabled={!blocks.length}><Icon name="download" /> Exportar JSON</button><button className="ghost" onClick={exportCsv} disabled={!blocks.length}><Icon name="download" /> Exportar CSV</button></div><small className="helper">{blocks.length ? `${blocks.length} bloques · ${blocks.reduce((sum, block) => sum + block.pages, 0)} hojas · ${blocks.reduce((sum, block) => sum + block.pages * 4, 0)} cartones` : 'Genera un lote para habilitar la exportación.'}</small></section><section className="panel integration-panel"><div className="eyebrow">IMPORTAR DESDE PROMAX</div><h3>Recibir un paquete</h3><p>Importa un JSON v1.0 o v1.1 generado por Bingo ProMax Studio.</p><label className="file-drop"><input type="file" accept="application/json,.json" onChange={importFile} /><span>＋ Seleccionar paquete JSON</span><small>El archivo se valida antes de incorporarse al inventario local.</small></label>{message && <div className="success-box">✓ {message}</div>}{error && <div className="error-box">{error}</div>}</section></div><section className="panel contract-panel"><div className="panel-heading"><div><div className="eyebrow">CONTRATO DE DATOS</div><h3>Formato compatible con Bingo Control ProMax</h3><p>Los nombres siguen las interfaces y acciones de su API de estado.</p></div><span className="preview-tag">v1.1</span></div><div className="contract-table"><div><code>game</code><span>Partida lista para importar</span></div><div><code>cards[].number</code><span>Numeración del cartón</span></div><div><code>cards[].grid</code><span>Matriz plana de 25 valores; 0 representa centro libre</span></div><div><code>cards[].layout</code><span>Diseño classic-5x5 con filas, columnas y celdas</span></div><div><code>cards[].sourcePage</code><span>Página original dentro de la hoja PDF</span></div><div><code>blocks[].code</code><span>Código único del bloque de 40 hojas</span></div></div></section><section className="api-roadmap"><span>API futura</span><b>POST /api/integration/promax/import</b><b>GET /api/integration/promax/blocks/:code</b><b>POST /api/integration/promax/games</b></section></div> }

function Users({ currentMember, onTenantCreated }: { currentMember: StudioMember | null; onTenantCreated: (tenantId: string) => void }) {
  const [members, setMembers] = useState<StudioMember[]>([])
  const [email, setEmail] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canManage = currentMember?.role === 'developer'
  useEffect(() => { let active = true; void loadStudioMembers().then(remote => { if (active && remote.length) setMembers(remote) }).catch(() => { /* The initial allowlist remains visible before migration. */ }); return () => { active = false } }, [])
  useEffect(() => { if (!members.length) setMembers(ALLOWED_EMAILS.map((memberEmail) => ({ email: memberEmail, role: 'developer', active: true, permissions: {} }))) }, [members.length])
  const save = async () => {
    const normalized = email.trim().toLowerCase()
    if (!normalized.includes('@')) { setError('Escribe un correo válido.'); return }
    setBusy(true); setError('')
    try { const created = await createStudioAdmin(normalized, normalized, 'Operación ' + normalized); const member: StudioMember = { email: normalized, role: 'admin', active: true, permissions: {}, tenantId: created.tenant_id, displayName: created.name }; setMembers(current => [...current, member]); onTenantCreated(created.tenant_id); appendAudit('ALTA_ADMINISTRADOR', `${normalized} agregado como administrador`); setOpen(false); setEmail('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo crear el administrador. Ejecuta la migración de Supabase primero.') } finally { setBusy(false) }
  }
  const removeAdmin = async (member: StudioMember) => { if (member.role !== 'admin' || !canManage || !window.confirm(`¿Desactivar el administrador ${member.email}?`)) return; setBusy(true); setError(''); try { await deleteStudioAdmin(member.email); setMembers(current => current.map(item => item.email === member.email ? { ...item, active: false } : item)); appendAudit('BAJA_ADMINISTRADOR', `${member.email} desactivado`) } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desactivar el administrador.') } finally { setBusy(false) } }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">CONTROL DE ACCESO</div><h1>Administradores autorizados.</h1><p className="muted">Solo las cuentas desarrolladoras pueden crear y desactivar administradores. Cada administrador recibe su propio espacio aislado.</p></div><button className="primary" disabled={!canManage} onClick={() => { setError(''); setOpen(true) }}><Icon name="plus" /> Crear administrador</button></div>{error && <div className="error-box">{error}</div>}<section className="panel table-panel"><div className="panel-heading"><div><h3>Equipo del estudio</h3><p>Las dos cuentas iniciales mantienen el rol desarrollador.</p></div><span className="preview-tag">{members.length} CUENTAS</span></div><div className="user-list">{members.map(member => <UserRow key={member.email} member={member} onDelete={() => void removeAdmin(member)} canDelete={canManage && member.role === 'admin'} />)}</div></section>{open && <div className="modal-backdrop"><section className="modal small-modal"><header><div><span className="eyebrow">NUEVO ADMINISTRADOR</span><h2>Crear espacio</h2></div><button className="icon-button" onClick={() => setOpen(false)} type="button">×</button></header><div className="form-stack"><label>Correo del administrador<input autoFocus type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="admin@dominio.com" /></label><div className="success-box">Se creará automáticamente un espacio independiente para sus cartones, bloques y red comercial.</div>{error && <div className="error-box">{error}</div>}</div><footer><button className="ghost" onClick={() => setOpen(false)} type="button">Cancelar</button><button className="primary" disabled={busy} onClick={() => void save()} type="button">{busy ? 'Creando…' : 'Crear administrador'}</button></footer></section></div>}</div>
}
function UserRow({ member, onDelete, canDelete = false }: { member: StudioMember; onDelete?: () => void; canDelete?: boolean }) { const label = member.role === 'developer' ? 'Desarrollador' : member.role === 'admin' ? 'Administrador' : member.role === 'distributor' ? 'Distribuidor' : member.role === 'seller' ? 'Vendedor' : 'Operador'; return <div className="user-row"><div className="avatar">{member.email.slice(0, 2).toUpperCase()}</div><div><b>{member.displayName || member.email}</b><span>{label} · {member.email}</span></div><span className={`status ${member.active ? 'listo' : 'entregado'}`}>{member.active ? 'Activo' : 'Inactivo'}</span>{canDelete ? <button className="icon-button danger" onClick={onDelete} title="Desactivar administrador">×</button> : <button className="icon-button" disabled title="Gestionado por su rol">⋯</button>}</div> }

function LegacyNetwork({ tenantId, member, blocks, onTransferred }: { tenantId?: string; member: StudioMember | null; blocks: BingoBlock[]; onTransferred: (code: string, patch: Partial<BingoBlock>) => void }) {
  const [distributors, setDistributors] = useState<StudioParty[]>([])
  const [sellers, setSellers] = useState<StudioParty[]>([])
  const [clients, setClients] = useState<StudioClient[]>([])
  const [transfers, setTransfers] = useState<StudioTransfer[]>([])
  const [sales, setSales] = useState<StudioSale[]>([])
  const [watermarks, setWatermarks] = useState<StudioWatermark[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [distributorId, setDistributorId] = useState('')
  const [blockCode, setBlockCode] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [saleBlockCode, setSaleBlockCode] = useState('')
  const [saleSheets, setSaleSheets] = useState(1)
  const [saleAmount, setSaleAmount] = useState(0)
  const [watermarkName, setWatermarkName] = useState('Marca discreta')
  const [watermarkText, setWatermarkText] = useState('BINGO PROMAX')
  const [watermarkDistributorId, setWatermarkDistributorId] = useState('')
  const [watermarkSellerId, setWatermarkSellerId] = useState('')
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.12)
  const [watermarkPosition, setWatermarkPosition] = useState<StudioWatermark['position']>('bottom-right')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const isManager = member?.role === 'developer' || member?.role === 'admin'
  const isDistributor = member?.role === 'distributor'
  const canSell = isDistributor || member?.role === 'seller'
  const destinationType: 'distributor' | 'seller' = isManager ? 'distributor' : 'seller'
  const destinations = destinationType === 'distributor' ? distributors : sellers.filter((seller) => member?.role !== 'distributor' || seller.distributorId === member.partyId)
  const ownedBlocks = blocks.filter((block) => block.holderType === member?.role && block.holderId === member?.partyId)
  const refresh = async () => {
    if (!tenantId) return
    try {
      const network = await loadStudioNetwork(tenantId)
      setDistributors(network.distributors); setSellers(network.sellers); setClients(network.clients); setTransfers(network.transfers); setSales(network.sales)
      setWatermarks(await loadStudioWatermarks(tenantId))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo cargar la red comercial.') }
  }
  useEffect(() => { void refresh() }, [tenantId])
  const createParty = async (type: 'distributor' | 'seller') => {
    if (!tenantId || !name.trim() || !email.trim() || (type === 'seller' && !distributorId)) { setError(type === 'seller' ? 'Completa nombre, correo y distribuidor.' : 'Completa nombre y correo.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      await createStudioPartyAccount(type, name, email, phone, type === 'seller' ? distributorId : undefined, tenantId)
      const createdEmail = email.trim().toLowerCase()
      setName(''); setEmail(''); setPhone(''); setDistributorId(''); setMessage((type === 'seller' ? 'Vendedor' : 'Distribuidor') + ' creado. Ya puede acceder con enlace seguro.'); await refresh(); appendAudit('ALTA_RED_COMERCIAL', type + ' ' + createdEmail + ' creado')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo crear la cuenta.') } finally { setBusy(false) }
  }
  const createClient = async () => {
    if (!tenantId || !clientName.trim()) { setError('Escribe el nombre del cliente.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      await createStudioClient(clientName, clientEmail, clientPhone, tenantId)
      setClientName(''); setClientEmail(''); setClientPhone(''); setMessage('Cliente registrado correctamente.'); await refresh(); appendAudit('ALTA_CLIENTE', clientName.trim() + ' registrado')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar el cliente.') } finally { setBusy(false) }
  }
  const transfer = async () => {
    const block = blocks.find((item) => item.code === blockCode)
    const destination = destinations.find((item) => item.id === destinationId)
    if (!block || !destination) { setError('Selecciona un bloque y un destinatario válido.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      await transferStudioBlock(block.code, destinationType, destination.id)
      onTransferred(block.code, { status: 'Entregado', distributor: destinationType === 'distributor' ? destination.name : block.distributor, deliveredAt: new Date().toISOString(), holderType: destinationType, holderId: destination.id, holderName: destination.name })
      setMessage('Bloque ' + block.code + ' transferido a ' + destination.name + '.'); setBlockCode(''); setDestinationId(''); await refresh(); appendAudit('TRANSFERENCIA_BLOQUE', block.code + ' → ' + destination.name)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar la transferencia.') } finally { setBusy(false) }
  }
  const recordSale = async () => {
    const block = ownedBlocks.find((item) => item.code === saleBlockCode)
    if (!block || !member || !clientId) { setError('Selecciona un bloque y un cliente.'); return }
    if (!Number.isInteger(saleSheets) || saleSheets < 1 || saleSheets > block.pages) { setError('La cantidad de hojas no es válida para este bloque.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      await recordStudioSale({ blockCode: block.code, sellerType: member.role as 'distributor' | 'seller', sellerId: member.partyId ?? '', clientId, sheetsSold: saleSheets, cardsSold: saleSheets * 4, amount: saleAmount })
      setSaleBlockCode(''); setClientId(''); setSaleSheets(1); setSaleAmount(0); setMessage('Venta registrada: ' + block.code + '.'); await refresh(); appendAudit('REGISTRO_VENTA', block.code + ' · ' + saleSheets + ' hojas')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar la venta.') } finally { setBusy(false) }
  }
  const editParty = async (party: StudioParty) => {
    if (!isManager) return
    const nextName = window.prompt('Nombre de la cuenta', party.name)
    if (nextName === null || !nextName.trim()) return
    const nextEmail = window.prompt('Correo de acceso', party.email)
    if (nextEmail === null || !nextEmail.trim()) return
    setBusy(true); setError('')
    try { await updateStudioPartyAccount({ type: party.type, id: party.id, name: nextName, email: nextEmail, phone: party.phone, distributorId: party.type === 'seller' ? party.distributorId : undefined }); await refresh(); appendAudit('EDICION_RED_COMERCIAL', `${party.type} ${nextEmail} editado`) } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo editar la cuenta.') } finally { setBusy(false) }
  }
  const removeParty = async (party: StudioParty) => {
    if (!isManager || !window.confirm(`¿Desactivar ${party.name}?`)) return
    setBusy(true); setError('')
    try { await deleteStudioPartyAccount(party.type, party.id); await refresh(); appendAudit('BAJA_RED_COMERCIAL', `${party.type} ${party.email} desactivado`) } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desactivar la cuenta.') } finally { setBusy(false) }
  }
  const createWatermark = async () => {
    const owner = watermarkDistributorId || distributors[0]?.id
    if (!tenantId || !owner || !watermarkName.trim() || !watermarkText.trim()) { setError('Completa el nombre, texto y distribuidor de la marca.'); return }
    setBusy(true); setError('')
    try { await saveStudioWatermark({ tenantId, distributorId: owner, sellerId: watermarkSellerId || undefined, name: watermarkName, text: watermarkText, opacity: watermarkOpacity, position: watermarkPosition }); setMessage('Marca de agua guardada.'); setWatermarkName('Marca discreta'); setWatermarkText('BINGO PROMAX'); setWatermarkSellerId(''); await refresh(); appendAudit('ALTA_MARCA_AGUA', `${watermarkName} creada`) } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar la marca de agua.') } finally { setBusy(false) }
  }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">RED COMERCIAL</div><h1>La distribución, trazable.</h1><p className="muted">Cada administrador mantiene sus propios distribuidores, vendedores, clientes y bloques. Las operaciones quedan registradas.</p></div><div className="secure-badge"><Icon name="lock" /> Espacio aislado</div></div>{(error || message) && <div className={error ? 'error-box' : 'success-box'}>{error || message}</div>}<div className="content-grid"><section className="panel form-panel"><div className="eyebrow">{isManager ? 'NUEVA CUENTA COMERCIAL' : 'OPERACIÓN COMERCIAL'}</div><h3>{isManager ? 'Crear distribuidor o vendedor' : canSell ? 'Registrar una venta' : 'Transferir bloques recibidos'}</h3>{isManager ? <div className="form-stack"><label>Nombre<input value={name} onChange={event => setName(event.target.value)} placeholder="Distribución Central" /></label><label>Correo de acceso<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="contacto@dominio.com" /></label><label>Teléfono<input value={phone} onChange={event => setPhone(event.target.value)} placeholder="Opcional" /></label><div className="two-fields"><button className="primary" disabled={busy} onClick={() => void createParty('distributor')}><Icon name="plus" /> Distribuidor</button><button className="ghost" disabled={busy || !distributorId} onClick={() => void createParty('seller')}><Icon name="plus" /> Vendedor</button></div><label>Distribuidor del vendedor<select value={distributorId} onChange={event => setDistributorId(event.target.value)}><option value="">Seleccionar…</option>{distributors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><small className="helper">Los nuevos accesos reciben un enlace de un solo uso. El administrador conserva el control del espacio.</small></div> : canSell ? <div className="form-stack"><label>Bloque propio<select value={saleBlockCode} onChange={event => setSaleBlockCode(event.target.value)}><option value="">Seleccionar…</option>{ownedBlocks.map(block => <option key={block.code} value={block.code}>{block.code} · {block.pages} hojas</option>)}</select></label><label>Cliente<select value={clientId} onChange={event => setClientId(event.target.value)}><option value="">Seleccionar…</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label>Hojas vendidas<input type="number" min="1" value={saleSheets} onChange={event => setSaleSheets(Math.max(1, Number(event.target.value)))} /></label><label>Importe<input type="number" min="0" step="0.01" value={saleAmount} onChange={event => setSaleAmount(Math.max(0, Number(event.target.value)))}/></label><button className="primary wide" disabled={busy} onClick={() => void recordSale()}><Icon name="check" /> Registrar venta</button><small className="helper">Cada hoja representa cuatro cartones. Solo puedes vender bloques que estén a tu nombre.</small></div> : <div className="form-stack"><label>Bloque recibido<select value={blockCode} onChange={event => setBlockCode(event.target.value)}><option value="">Seleccionar…</option>{blocks.filter(block => block.holderId === member?.partyId).map(block => <option key={block.code} value={block.code}>{block.code} · {block.pages} hojas</option>)}</select></label><label>Vendedor destino<select value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">Seleccionar…</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="primary wide" disabled={busy} onClick={() => void transfer()}><Icon name="arrow" /> Transferir a vendedor</button><small className="helper">La transferencia solo puede hacerla el distribuidor que posee el bloque.</small></div>}</section><section className="panel form-panel"><div className="eyebrow">CLIENTES</div><h3>Registrar cliente</h3><div className="form-stack"><label>Nombre<input value={clientName} onChange={event => setClientName(event.target.value)} placeholder="Cliente final" /></label><label>Correo<input type="email" value={clientEmail} onChange={event => setClientEmail(event.target.value)} placeholder="Opcional" /></label><label>Teléfono<input value={clientPhone} onChange={event => setClientPhone(event.target.value)} placeholder="Opcional" /></label><button className="ghost wide" disabled={busy} onClick={() => void createClient()}><Icon name="plus" /> Guardar cliente</button><small className="helper">El cliente no recibe acceso a Studio; solo queda asociado a la venta.</small></div></section></div><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">CUENTAS DEL ESPACIO</div><h3>Distribuidores, vendedores y clientes</h3></div><span className="preview-tag">{distributors.length + sellers.length + clients.length} REGISTROS</span></div><div className="user-list">{distributors.map(item => <div className="user-row" key={item.id}><div className="avatar">D</div><div><b>{item.name}</b><span>Distribuidor · {item.email}</span></div><span className="status listo">Activo</span></div>)}{sellers.map(item => <div className="user-row" key={item.id}><div className="avatar">V</div><div><b>{item.name}</b><span>Vendedor · {item.email}</span></div><span className="status listo">Activo</span></div>)}{clients.map(item => <div className="user-row" key={item.id}><div className="avatar">C</div><div><b>{item.name}</b><span>Cliente{item.email ? ' · ' + item.email : ''}</span></div><span className="status listo">Registrado</span></div>)}{!distributors.length && !sellers.length && !clients.length && <div className="empty-state"><b>Aún no hay registros comerciales</b><p>Registra la primera cuenta o cliente de este administrador.</p></div>}</div></section><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">VENTAS</div><h3>Ventas registradas</h3></div><span className="preview-tag">{sales.length} MOVIMIENTOS</span></div>{sales.length ? <div className="audit-list">{sales.slice(0, 50).map(item => <AuditRow key={item.id} icon="check" color="#b9ed2c" title={item.blockCode + ' · ' + item.clientName + ' · ' + item.sheetsSold + ' hojas'} actor={'$' + item.amount.toFixed(2)} time={new Date(item.soldAt).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })} />)}</div> : <div className="empty-state"><b>Sin ventas todavía</b><p>Las ventas aparecerán después de registrar la primera operación.</p></div>}</section><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">HISTORIAL</div><h3>Transferencias entre distribuidor y vendedor</h3></div><span className="preview-tag">{transfers.length} MOVIMIENTOS</span></div>{transfers.length ? <div className="audit-list">{transfers.slice(0, 50).map(item => <AuditRow key={item.id} icon="arrow" color="#6ee7d1" title={item.blockCode + ' · ' + item.fromName + ' → ' + item.toName} actor={item.transferredBy} time={new Date(item.createdAt).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })} />)}</div> : <div className="empty-state"><b>Sin transferencias todavía</b><p>El historial aparecerá aquí después de entregar el primer bloque.</p></div>}</section></div>
}

function Network({ tenantId, member, blocks, onTransferred }: { tenantId?: string; member: StudioMember | null; blocks: BingoBlock[]; onTransferred: (code: string, patch: Partial<BingoBlock>) => void }) {
  const [distributors, setDistributors] = useState<StudioParty[]>([])
  const [sellers, setSellers] = useState<StudioParty[]>([])
  const [clients, setClients] = useState<StudioClient[]>([])
  const [transfers, setTransfers] = useState<StudioTransfer[]>([])
  const [sales, setSales] = useState<StudioSale[]>([])
  const [watermarks, setWatermarks] = useState<StudioWatermark[]>([])
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState(''); const [type, setType] = useState<'distributor' | 'seller'>('distributor'); const [distributorId, setDistributorId] = useState('')
  const [clientName, setClientName] = useState(''); const [clientEmail, setClientEmail] = useState(''); const [clientPhone, setClientPhone] = useState('')
  const [blockCode, setBlockCode] = useState(''); const [destinationId, setDestinationId] = useState(''); const [saleClientId, setSaleClientId] = useState(''); const [saleSheets, setSaleSheets] = useState(1); const [saleAmount, setSaleAmount] = useState(0)
  const [watermarkName, setWatermarkName] = useState('Marca discreta'); const [watermarkText, setWatermarkText] = useState('BINGO PROMAX'); const [watermarkDistributorId, setWatermarkDistributorId] = useState(''); const [watermarkSellerId, setWatermarkSellerId] = useState(''); const [watermarkOpacity, setWatermarkOpacity] = useState(0.12); const [watermarkPosition, setWatermarkPosition] = useState<StudioWatermark['position']>('bottom-right')
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const isManager = member?.role === 'developer' || member?.role === 'admin'; const isDistributor = member?.role === 'distributor'; const canSell = isDistributor || member?.role === 'seller'
  const ownedBlocks = blocks.filter(block => block.holderId === member?.partyId)
  const refresh = async () => { if (!tenantId) return; try { const network = await loadStudioNetwork(tenantId); setDistributors(network.distributors); setSellers(network.sellers); setClients(network.clients); setTransfers(network.transfers); setSales(network.sales); setWatermarks(await loadStudioWatermarks(tenantId)) } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo cargar la red comercial.') } }
  useEffect(() => { void refresh() }, [tenantId])
  const saveParty = async () => { if (!tenantId || !name.trim() || !email.trim() || (type === 'seller' && !distributorId)) { setError('Completa nombre, correo y distribuidor para el vendedor.'); return }; setBusy(true); setError(''); try { await createStudioPartyAccount(type, name, email, phone, type === 'seller' ? distributorId : undefined, tenantId); setMessage(`${type === 'seller' ? 'Vendedor' : 'Distribuidor'} creado.`); setName(''); setEmail(''); setPhone(''); setDistributorId(''); await refresh() } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo crear la cuenta.') } finally { setBusy(false) } }
  const editParty = async (party: StudioParty) => { if (!isManager) return; const nextName = window.prompt('Nombre', party.name); if (nextName === null) return; const nextEmail = window.prompt('Correo', party.email); if (nextEmail === null) return; setBusy(true); try { await updateStudioPartyAccount({ type: party.type, id: party.id, name: nextName, email: nextEmail, phone: party.phone, distributorId: party.distributorId }); await refresh(); setMessage('Cuenta actualizada.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo editar la cuenta.') } finally { setBusy(false) } }
  const removeParty = async (party: StudioParty) => { if (!isManager || !window.confirm(`¿Desactivar ${party.name}?`)) return; setBusy(true); try { await deleteStudioPartyAccount(party.type, party.id); await refresh(); setMessage('Cuenta desactivada.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desactivar la cuenta.') } finally { setBusy(false) } }
  const saveClient = async () => { if (!tenantId || !clientName.trim()) { setError('Escribe el nombre del cliente.'); return }; setBusy(true); try { await createStudioClient(clientName, clientEmail, clientPhone, tenantId); setClientName(''); setClientEmail(''); setClientPhone(''); await refresh(); setMessage('Cliente registrado.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar el cliente.') } finally { setBusy(false) } }
  const transfer = async () => { const destination = sellers.find(item => item.id === destinationId); const block = blocks.find(item => item.code === blockCode); if (!block || !destination) { setError('Selecciona un bloque y un vendedor.'); return }; setBusy(true); try { await transferStudioBlock(block.code, 'seller', destination.id); onTransferred(block.code, { status: 'Entregado', holderType: 'seller', holderId: destination.id, holderName: destination.name, distributor: block.distributor, deliveredAt: new Date().toISOString() }); await refresh(); setMessage('Transferencia registrada.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo transferir el bloque.') } finally { setBusy(false) } }
  const sale = async () => { const block = ownedBlocks.find(item => item.code === blockCode); if (!block || !saleClientId || !member?.partyId) { setError('Selecciona tu bloque y un cliente.'); return }; setBusy(true); try { await recordStudioSale({ blockCode: block.code, sellerType: member.role as 'distributor' | 'seller', sellerId: member.partyId, clientId: saleClientId, sheetsSold: saleSheets, cardsSold: saleSheets * 4, amount: saleAmount }); await refresh(); setMessage('Venta registrada.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar la venta.') } finally { setBusy(false) } }
  const saveWatermark = async () => { const owner = watermarkDistributorId || distributors[0]?.id; if (!tenantId || !owner || !watermarkName.trim() || !watermarkText.trim()) { setError('Completa los datos de la marca de agua.'); return }; setBusy(true); try { await saveStudioWatermark({ tenantId, distributorId: owner, sellerId: watermarkSellerId || undefined, name: watermarkName, text: watermarkText, opacity: watermarkOpacity, position: watermarkPosition }); await refresh(); setMessage('Marca de agua guardada.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar la marca de agua.') } finally { setBusy(false) } }
  const partyRows = [...distributors.map(item => ({ ...item, label: 'Distribuidor' })), ...sellers.map(item => ({ ...item, label: 'Vendedor' }))]
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">RED COMERCIAL</div><h1>La distribución, trazable.</h1><p className="muted">Cada administrador mantiene su equipo, clientes, bloques y operaciones en un espacio aislado.</p></div><div className="secure-badge"><Icon name="lock" /> Espacio aislado</div></div>{(message || error) && <div className={error ? 'error-box' : 'success-box'}>{error || message}</div>}<div className="content-grid"><section className="panel form-panel"><div className="eyebrow">{isManager ? 'CUENTAS COMERCIALES' : isDistributor ? 'TRANSFERIR BLOQUE' : 'VENTA DIRECTA'}</div><h3>{isManager ? 'Crear distribuidor o vendedor' : isDistributor ? 'Transferir a vendedor' : 'Registrar una venta'}</h3>{isManager ? <div className="form-stack"><label>Tipo<select value={type} onChange={event => setType(event.target.value as 'distributor' | 'seller')}><option value="distributor">Distribuidor</option><option value="seller">Vendedor</option></select></label><label>Nombre<input value={name} onChange={event => setName(event.target.value)} /></label><label>Correo de acceso<input type="email" value={email} onChange={event => setEmail(event.target.value)} /></label><label>Teléfono<input value={phone} onChange={event => setPhone(event.target.value)} /></label>{type === 'seller' && <label>Distribuidor<select value={distributorId} onChange={event => setDistributorId(event.target.value)}><option value="">Seleccionar…</option>{distributors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<button className="primary wide" disabled={busy} onClick={() => void saveParty()}><Icon name="plus" /> Crear cuenta</button></div> : canSell ? <div className="form-stack"><label>Bloque propio<select value={blockCode} onChange={event => setBlockCode(event.target.value)}><option value="">Seleccionar…</option>{ownedBlocks.map(item => <option key={item.code} value={item.code}>{item.code} · {item.pages} hojas</option>)}</select></label><label>Cliente<select value={saleClientId} onChange={event => setSaleClientId(event.target.value)}><option value="">Seleccionar…</option>{clients.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Hojas vendidas<input type="number" min="1" value={saleSheets} onChange={event => setSaleSheets(Math.max(1, Number(event.target.value)))} /></label><label>Importe<input type="number" min="0" step="0.01" value={saleAmount} onChange={event => setSaleAmount(Math.max(0, Number(event.target.value)))} /></label><button className="primary wide" disabled={busy} onClick={() => void sale()}><Icon name="check" /> Registrar venta</button></div> : <div className="form-stack"><label>Bloque recibido<select value={blockCode} onChange={event => setBlockCode(event.target.value)}><option value="">Seleccionar…</option>{ownedBlocks.map(item => <option key={item.code} value={item.code}>{item.code}</option>)}</select></label><label>Vendedor<select value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">Seleccionar…</option>{sellers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="primary wide" disabled={busy} onClick={() => void transfer()}><Icon name="arrow" /> Transferir bloque</button></div>}</section><section className="panel form-panel"><div className="eyebrow">CLIENTES</div><h3>Registrar cliente</h3><div className="form-stack"><label>Nombre<input value={clientName} onChange={event => setClientName(event.target.value)} /></label><label>Correo<input value={clientEmail} onChange={event => setClientEmail(event.target.value)} /></label><label>Teléfono<input value={clientPhone} onChange={event => setClientPhone(event.target.value)} /></label><button className="ghost wide" disabled={busy} onClick={() => void saveClient()}><Icon name="plus" /> Guardar cliente</button></div></section></div><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">CUENTAS DEL ESPACIO</div><h3>Equipo comercial</h3></div><span className="preview-tag">{partyRows.length + clients.length} REGISTROS</span></div><div className="user-list">{partyRows.map(item => <div className="user-row" key={item.id}><div className="avatar">{item.label[0]}</div><div><b>{item.name}</b><span>{item.label} · {item.email}</span></div><span className="status listo">Activo</span>{isManager && <><button className="icon-button" onClick={() => void editParty(item)} title="Editar">⌕</button><button className="icon-button danger" onClick={() => void removeParty(item)} title="Desactivar">×</button></>}</div>)}{clients.map(item => <div className="user-row" key={item.id}><div className="avatar">C</div><div><b>{item.name}</b><span>Cliente{item.email ? ` · ${item.email}` : ''}</span></div><span className="status listo">Registrado</span></div>)}</div></section>{isManager || isDistributor ? <section className="panel form-panel"><div className="eyebrow">PROTECCIÓN DE DISTRIBUCIÓN</div><h3>Marcas de agua discretas</h3><p className="muted">No cubren códigos ni numeraciones.</p><div className="form-stack"><label>Distribuidor<select value={watermarkDistributorId} onChange={event => setWatermarkDistributorId(event.target.value)}><option value="">Seleccionar…</option>{distributors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Vendedor específico<select value={watermarkSellerId} onChange={event => setWatermarkSellerId(event.target.value)}><option value="">Todos sus vendedores</option>{sellers.filter(item => !watermarkDistributorId || item.distributorId === watermarkDistributorId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Nombre<input value={watermarkName} onChange={event => setWatermarkName(event.target.value)} /></label><label>Texto<input value={watermarkText} onChange={event => setWatermarkText(event.target.value)} /></label><label>Opacidad<input type="number" min="0.03" max="0.30" step="0.01" value={watermarkOpacity} onChange={event => setWatermarkOpacity(Number(event.target.value))} /></label><label>Posición<select value={watermarkPosition} onChange={event => setWatermarkPosition(event.target.value as StudioWatermark['position'])}><option value="top-left">Arriba izquierda</option><option value="top-right">Arriba derecha</option><option value="bottom-left">Abajo izquierda</option><option value="bottom-right">Abajo derecha</option></select></label><button className="primary" disabled={busy} onClick={() => void saveWatermark()}><Icon name="plus" /> Guardar marca</button><small className="helper">{watermarks.length} marcas configuradas en este espacio.</small></div></section> : null}<section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">VENTAS Y TRANSFERENCIAS</div><h3>Historial operativo</h3></div><span className="preview-tag">{sales.length + transfers.length} MOVIMIENTOS</span></div>{sales.slice(0, 30).map(item => <AuditRow key={item.id} icon="check" color="#b9ed2c" title={`${item.blockCode} · ${item.clientName} · ${item.sheetsSold} hojas`} actor={`$${item.amount.toFixed(2)}`} time={new Date(item.soldAt).toLocaleString('es-EC')} />)}{transfers.slice(0, 30).map(item => <AuditRow key={item.id} icon="arrow" color="#6ee7d1" title={`${item.blockCode} · ${item.fromName} → ${item.toName}`} actor={item.transferredBy} time={new Date(item.createdAt).toLocaleString('es-EC')} />)}</section></div>
}

function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>(() => {
    try { return JSON.parse(localStorage.getItem('bps-audit') ?? '[]') as AuditEvent[] } catch { return [] }
  })
  useEffect(() => {
    let active = true
    void loadStudioAuditEvents().then((remote) => {
      if (active && remote.length) setEvents(remote)
    }).catch(() => { /* Offline mode keeps the local audit trail. */ })
    return () => { active = false }
  }, [])
  const exportLog = () => triggerDownload(new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' }), 'bingo-promax-studio-auditoria.json')
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">TRAZABILIDAD</div><h1>Cada acción, registrada.</h1><p className="muted">Consulta la actividad importante del estudio.</p></div><button className="ghost" onClick={exportLog}><Icon name="download" /> Exportar registro</button></div><section className="panel table-panel"><div className="panel-heading"><div><h3>Registro de actividad</h3><p>Descargas, entregas y operaciones del estudio.</p></div><span className="preview-tag">{events.length ? `${events.length} EVENTOS` : 'SIN EVENTOS'}</span></div><div className="audit-list">{events.length ? events.slice(0, 100).map(event => <AuditRow key={event.id} icon={event.action === 'ENTREGA_BLOQUE' ? 'users' : 'download'} color={event.action === 'ENTREGA_BLOQUE' ? '#bda1ff' : '#6ee7d1'} title={event.detail} actor={event.actor} time={new Date(event.createdAt).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })} />) : <AuditRow icon="spark" color="#f5c84b" title="El registro está listo para recibir operaciones" actor="Sistema" time="Ahora" />}</div></section></div>
}
function AuditRow({ icon, color, title, actor, time }: { icon: string; color: string; title: string; actor: string; time: string }) { return <div className="audit-row"><div className="activity-icon" style={{ color, background: `${color}18` }}><Icon name={icon} /></div><div><b>{title}</b><span>{actor}</span></div><time>{time}</time></div> }

function App() {
  const [email, setEmail] = useState<string | null>(null)
  const [currentMember, setCurrentMember] = useState<StudioMember | null>(null)
  const [tenants, setTenants] = useState<StudioTenant[]>([])
  const [activeTenantId, setActiveTenantId] = useState<string | undefined>()
  const [authReady, setAuthReady] = useState(false)
  const [view, setView] = useState<View>('dashboard')
  const [blocks, setBlocks] = useState<BingoBlock[]>([])
  const [selectedPatterns, setSelectedPatterns] = useState(['full', 'letter-a', 'letter-b', 'letter-c'])

  useEffect(() => {
    let mounted = true
    const acceptSession = async (sessionEmail: string | undefined) => {
      const normalized = sessionEmail?.trim().toLowerCase() ?? ''
      let member: StudioMember | null = null
      if (normalized && !ALLOWED_EMAILS.includes(normalized)) {
        try { member = await loadStudioMember(normalized) } catch { member = null }
      }
      const allowed = ALLOWED_EMAILS.includes(normalized) || Boolean(member?.active)
      if (mounted && allowed) {
        localStorage.setItem('bps-email', normalized)
        setEmail(normalized)
        setCurrentMember(member ?? { email: normalized, role: 'developer', active: true, permissions: {} })
      } else if (mounted) {
        localStorage.removeItem('bps-email')
        setEmail(null)
        setCurrentMember(null)
      }
      if (mounted) setAuthReady(true)
      return allowed
    }
    void supabase.auth.getSession().then(({ data }) => {
      const sessionEmail = data.session?.user.email
      void acceptSession(sessionEmail).then((allowed) => { if (sessionEmail && !allowed) void supabase.auth.signOut() })
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionEmail = session?.user.email
      void acceptSession(sessionEmail).then((allowed) => { if (sessionEmail && !allowed) window.setTimeout(() => void supabase.auth.signOut(), 0) })
    })
    return () => { mounted = false; listener.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!currentMember) return
    let active = true
    void loadStudioTenants().then((available) => {
      if (!active) return
      setTenants(available)
      const saved = localStorage.getItem('bps-active-tenant') ?? undefined
      const next = currentMember.tenantId ?? (saved && available.some((tenant) => tenant.id === saved) ? saved : available[0]?.id)
      setActiveTenantId(next)
      if (next) localStorage.setItem('bps-active-tenant', next)
    }).catch(() => { if (active && currentMember.tenantId) setActiveTenantId(currentMember.tenantId) })
    return () => { active = false }
  }, [currentMember])

  useEffect(() => {
    let active = true
    if (!email) return () => { active = false }
    void loadPersistedBlocks(activeTenantId).then((stored) => {
      if (!active || !stored.length) return
      setBlocks((current) => current.length ? current : stored)
    })
    return () => { active = false }
  }, [email, activeTenantId])

  useEffect(() => {
    if (currentMember && !canAccessView(currentMember, view)) setView('dashboard')
  }, [currentMember, view])

  if (!authReady) return <main className="login-shell"><section className="login-card"><Logo /><p className="muted">Verificando la sesión segura…</p></section></main>
  if (!email) return <Login onLogin={async (value) => { const invited = ALLOWED_EMAILS.includes(value) ? true : (await supabase.rpc('studio_login_allowed', { p_email: value })).data === true; if (!invited) throw new Error('Esta cuenta no ha sido creada por un desarrollador.'); const { error } = await supabase.auth.signInWithOtp({ email: value, options: { shouldCreateUser: true, emailRedirectTo: STUDIO_AUTH_REDIRECT_URL } }); if (error) throw error }} />

  const logout = async () => { await supabase.auth.signOut(); localStorage.removeItem('bps-email'); setEmail(null) }
  const onGenerated = (nextBlocks: BingoBlock[], update: GenerationUpdate = 'complete') => { setBlocks(current => { const merged = [...current]; nextBlocks.forEach(block => { const index = merged.findIndex(existing => existing.code === block.code); if (index >= 0) merged[index] = block; else merged.push(block) }); if (update === 'complete') void persistBlocks(merged, true, activeTenantId); return merged }) }
  const onImported = (importedBlocks: BingoBlock[]) => { setBlocks(current => { const merged = [...current]; importedBlocks.forEach(block => { const index = merged.findIndex(existing => existing.code === block.code); if (index >= 0) merged[index] = block; else merged.push(block) }); void persistBlocks(merged, true, activeTenantId); return merged }) }
  const onBlockUpdate = (code: string, patch: Partial<BingoBlock>) => { setBlocks(current => { const next = current.map(block => block.code === code ? { ...block, ...patch } : block); const updated = next.find(block => block.code === code); void persistBlocks(next, false, activeTenantId); if (updated) void syncStudioBlock(updated, activeTenantId).catch(() => { /* Offline delivery remains local. */ }); return next }) }
  const onBlockDelete = async (code: string) => { await deleteStudioBlock(code, activeTenantId); setBlocks(current => { const next = current.filter(block => block.code !== code); void persistBlocks(next, false, activeTenantId); return next }) }
  const onTenantChange = (tenantId: string) => { setActiveTenantId(tenantId); localStorage.setItem('bps-active-tenant', tenantId); setBlocks([]); setView('dashboard') }
  const content = { dashboard: <Dashboard setView={setView} blocks={blocks} />, generator: <Generator onGenerated={onGenerated} setView={setView} tenantId={activeTenantId} existingBlocks={blocks} />, blocks: <Blocks blocks={blocks} setView={setView} onUpdate={onBlockUpdate} onDelete={onBlockDelete} member={currentMember} />, network: <Network tenantId={activeTenantId} member={currentMember} blocks={blocks} onTransferred={onBlockUpdate} />, games: <CompleteGames selectedPatterns={selectedPatterns} setSelectedPatterns={setSelectedPatterns} blocks={blocks} tenantId={activeTenantId} member={currentMember} />, patterns: <Patterns tenantId={activeTenantId} />, integration: <Integration blocks={blocks} onImport={onImported} />, users: <Users currentMember={currentMember} onTenantCreated={(tenantId) => { void loadStudioTenants().then(setTenants); onTenantChange(tenantId) }} />, audit: <Audit /> }[view]
  return <div className="app-shell"><Sidebar view={view} setView={setView} email={email} blocks={blocks} member={currentMember} /><main className="main-area"><Topbar view={view} onLogout={() => void logout()} tenants={tenants} activeTenantId={activeTenantId} onTenantChange={onTenantChange} />{content}</main></div>
}

createRoot(document.getElementById('root')!).render(<App />)
