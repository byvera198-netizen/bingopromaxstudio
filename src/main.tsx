import { useEffect, useState } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { blocksToJson, blocksToProMaxCsv, blocksToProMaxJson as blocksToProMaxJsonBase, createBlockPdf, createBlocksZip, generateBatch, isPatternComplete, parseProMaxPackage, triggerDownload, type BingoBlock, type BingoCard } from './bingo'
import { supabase } from './supabase'
import { loadStudioAuditEvents, loadStudioBlocks, loadStudioGame, loadStudioMember, loadStudioMembers, loadStudioPatterns, saveStudioMember, syncStudioBlock, syncStudioGame, syncStudioInventory, syncStudioPatterns, writeStudioAudit, type StudioGame, type StudioMember } from './studio-backend'
import './styles.css'

const ALLOWED_EMAILS = ['byvera198@gmail.com', 'bveraalvear@gmail.com']

type View = 'dashboard' | 'generator' | 'blocks' | 'games' | 'patterns' | 'integration' | 'users' | 'audit'
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
const BLOCK_DB_VERSION = 1
const BLOCK_STORE_NAME = 'snapshots'

function openBlockDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB no está disponible en este navegador.'))
      return
    }
    const request = window.indexedDB.open(BLOCK_DB_NAME, BLOCK_DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BLOCK_STORE_NAME)) request.result.createObjectStore(BLOCK_STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir el almacenamiento local.'))
  })
}

async function persistBlocks(blocks: BingoBlock[], syncRemote = true) {
  const totalSheets = blocks.reduce((total, block) => total + block.pages, 0)
  try {
    if (totalSheets <= 2000) localStorage.setItem('bps-blocks', JSON.stringify(blocks))
    else localStorage.removeItem('bps-blocks')
  } catch { /* IndexedDB below is the durable path for large inventories. */ }
  try {
    const database = await openBlockDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BLOCK_STORE_NAME, 'readwrite')
      transaction.objectStore(BLOCK_STORE_NAME).put({ id: 'current', blocks, savedAt: new Date().toISOString() })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('No se pudo guardar el inventario.')) }
    })
  } catch { /* The in-memory inventory remains available for the current session. */ }
  if (syncRemote) {
    try { await syncStudioInventory(blocks) } catch { /* The local inventory remains the offline source of truth. */ }
  }
}

async function loadPersistedBlocks(): Promise<BingoBlock[]> {
  try {
    const remote = await loadStudioBlocks()
    if (remote.length) return remote
  } catch { /* The migration may not be installed yet; use local persistence. */ }
  try {
    const database = await openBlockDatabase()
    const snapshot = await new Promise<{ blocks?: BingoBlock[] } | undefined>((resolve, reject) => {
      const request = database.transaction(BLOCK_STORE_NAME, 'readonly').objectStore(BLOCK_STORE_NAME).get('current')
      request.onsuccess = () => resolve(request.result as { blocks?: BingoBlock[] } | undefined)
      request.onerror = () => reject(request.error)
    })
    database.close()
    if (Array.isArray(snapshot?.blocks)) return snapshot.blocks
  } catch { /* Fall back to the fast localStorage path. */ }
  try {
    const stored = JSON.parse(localStorage.getItem('bps-blocks') ?? '[]')
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
  { id: 'letter-x', name: 'Letra X', description: 'Las dos diagonales forman una X.', group: 'Letras', color: '#d29cff', cells: [0, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24], active: true },
  { id: 'cross', name: 'Cruz', description: 'La fila y columna central.', group: 'Especiales', color: '#6ee7d1', cells: [2, 7, 10, 11, 12, 13, 14, 17, 22], active: true },
  { id: 'diamond', name: 'Diamante', description: 'Contorno en forma de diamante.', group: 'Especiales', color: '#7ca6ff', cells: [2, 6, 8, 10, 14, 16, 18, 22], active: false },
  { id: 'corners', name: 'Cuatro esquinas', description: 'Las cuatro esquinas del cartón.', group: 'Clásicos', color: '#ff9e5c', cells: [0, 4, 20, 24], active: false },
  { id: 'line', name: 'Línea central', description: 'Completar la fila central.', group: 'Clásicos', color: '#ef7898', cells: [10, 11, 12, 13, 14], active: false },
  { id: 'number-7', name: 'Número 7', description: 'Figura con forma de 7.', group: 'Números', color: '#b9ed2c', cells: [0, 1, 2, 3, 4, 9, 14, 19, 24], active: false },
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
const extraNames = ['Letra B','Letra C','Letra D','Letra E','Letra F','Letra G','Letra H','Letra I','Letra J','Letra K','Letra L','Letra M','Letra N','Letra O','Letra P','Letra Q','Letra R','Letra S','Letra T','Letra U','Letra V','Letra W','Letra X','Letra Y','Letra Z','Número 0','Número 1','Número 2','Número 3','Número 4','Número 5','Número 6','Número 7','Número 8','Número 9','Forma #1 completa','Forma #3 completa','Forma #4 completa','Forma #5 completa','Forma #7 completa','Forma #9 completa','Eche Leche','Bombombum','Keke Keke','Yapa','Avión','Flecha','Espada','Pesa','Rombo','Bomba','Sonrisa','Mini O','Perrito','Cruz','Más','Martillo']
const specialMasks = [maskFor('11111','10001','10001','10001','11111'), maskFor('00100','01110','11111','01110','00100'), maskFor('10001','01010','00100','01010','10001'), maskFor('11111','00100','00100','00100','11111'), maskFor('11111','10000','11110','10000','11111'), maskFor('10001','11011','10101','11011','10001'), maskFor('00100','01110','11111','01110','00100'), maskFor('10000','11000','10100','10010','10001'), maskFor('00001','00010','00100','01000','10000'), maskFor('10001','01010','00100','01010','10001'), maskFor('00100','01010','10001','01010','00100'), maskFor('01110','10001','10101','10001','01110'), maskFor('10001','01010','00100','01010','10001'), maskFor('00100','01110','00100','11111','00100'), maskFor('10001','10001','11111','10001','10001'), maskFor('01110','10001','11111','10001','01110'), maskFor('11111','10000','11111','10000','11111'), maskFor('10001','10101','10001','10101','10001'), maskFor('11111','10101','11111','10101','11111'), maskFor('10000','10000','11111','10000','10000')]
const extraPatterns: Pattern[] = extraNames.slice(0, 56).map((name, index) => { const key = name.replace('Letra ', '').replace('Número ', ''); const cells = name.startsWith('Letra ') ? (letterMasks[key] ?? maskFor('11111','00100','00100','00100','11111')) : name.startsWith('Número ') ? (numberMasks[key] ?? specialMasks[index % specialMasks.length]) : specialMasks[index % specialMasks.length]; const group = name.startsWith('Letra ') ? 'Letras' : name.startsWith('Número ') ? 'Números' : 'Especiales'; return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, description: `Figura ${name.toLowerCase()} para jugar en una partida.`, group, color: ['#b9ed2c','#6ee7d1','#bda1ff','#ff9e5c','#ef7898'][index % 5], cells, active: false } })
const patternCatalog: Pattern[] = [...seedPatterns, ...extraPatterns]
function readPatternCatalog(): Pattern[] { try { const saved: Pattern[] = JSON.parse(localStorage.getItem('bps-patterns') ?? '[]'); return patternCatalog.map(pattern => saved.find(item => item.id === pattern.id) ?? pattern).concat(saved.filter(item => !patternCatalog.some(pattern => pattern.id === item.id))) } catch { return patternCatalog } }
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
  return member.permissions[view] === true
}

function roleLabel(role: StudioMember['role'] | undefined) {
  return role === 'developer' ? 'Desarrollador' : role === 'admin' ? 'Administrador' : 'Operador'
}

function Login({ onLogin }: { onLogin: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    if (!ALLOWED_EMAILS.includes(normalized)) {
      setError('Esta cuenta todavía no está autorizada para acceder.')
      return
    }
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
    { label: 'OPERACIÓN', items: [['dashboard', 'grid', 'Resumen'], ['generator', 'spark', 'Generar cartones'], ['blocks', 'layers', 'Bloques y hojas'], ['games', 'play', 'Sala de juego']] },
    { label: 'CONFIGURACIÓN', items: [['patterns', 'spark', 'Patrones'], ['integration', 'arrow', 'Integración ProMax'], ['users', 'users', 'Usuarios'], ['audit', 'audit', 'Auditoría']] },
  ] as const
  return <aside className="sidebar">
    <div className="sidebar-top"><Logo compact /><button className="collapse" aria-label="Contraer menú" disabled>‹</button></div>
    <div className="profile"><div className="avatar">{email[0].toUpperCase()}</div><div><strong>{roleLabel(member?.role)}</strong><span>{email}</span></div><span className="online" /></div>
    <nav>{sections.map(section => <div className="nav-section" key={section.label}><div className="nav-label">{section.label}</div>{section.items.filter(([id]) => canAccessView(member, id as View)).map(([id, icon, label]) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id as View)}><Icon name={icon} /><span>{label}</span>{id === 'blocks' && <em>{blocks.length}</em>}</button>)}</div>)}</nav>
    <div className="sidebar-bottom"><div className="plan-card"><span className="plan-icon">✦</span><div><b>Studio Premium</b><small>Entorno protegido</small></div></div><button className="nav-item"><Icon name="settings" /><span>Configuración</span></button></div>
  </aside>
}

function Topbar({ view, onLogout }: { view: View; onLogout: () => void }) {
  const titles: Record<View, [string, string]> = { dashboard: ['Resumen general', 'Tu operación, en un vistazo.'], generator: ['Generador de cartones', 'Crea hojas listas para distribuir.'], blocks: ['Bloques y hojas', 'Organiza tus lotes de distribución.'], games: ['Sala de juego', 'Prepara y controla una nueva partida.'], patterns: ['Patrones de juego', 'Define las figuras que se jugarán.'], integration: ['Integración ProMax', 'Intercambia cartones y partidas con Bingo Control ProMax.'], users: ['Usuarios y accesos', 'Administra el equipo autorizado.'], audit: ['Auditoría', 'Actividad reciente del estudio.'] }
  return <header className="topbar"><div><div className="breadcrumb">BINGO PROMAX STUDIO <span>/</span> {titles[view][0].toUpperCase()}</div><h2>{titles[view][0]}</h2></div><div className="top-actions"><div className="status-dot"><span /> Sistema operativo</div><button className="ghost" onClick={onLogout}>Salir</button><button className="user-mini">BV</button></div></header>
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

function Generator({ onGenerated, setView }: { onGenerated: (blocks: BingoBlock[]) => void; setView: (view: View) => void }) {
  const [sheets, setSheets] = useState(100)
  const [code, setCode] = useState('BP-2026')
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const [generated, setGenerated] = useState<BingoBlock[]>([])
  const [error, setError] = useState('')
  const generate = () => {
    setError(''); setDone(false); setProgress(12)
    window.setTimeout(() => {
      try {
        const result = generateBatch(code, sheets)
        setGenerated(result); onGenerated(result); setProgress(100); setDone(true)
      } catch (generationError) { setProgress(0); setError(generationError instanceof Error ? generationError.message : 'No se pudo generar el lote.') }
    }, 80)
  }
  const downloadZip = async () => { if (!generated.length) return; const blob = await createBlocksZip(generated); triggerDownload(blob, `${code.toUpperCase()}-bloques.zip`) }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">NUEVA GENERACIÓN</div><h1>Diseña tu próximo lote.</h1><p className="muted">Cada hoja tendrá cuatro cartones únicos de 5×5 con centro libre.</p></div><div className="secure-badge"><Icon name="check" /> Motor real de cartones activos</div></div><div className="generator-layout"><section className="panel form-panel"><div className="panel-heading"><div><h3>Configuración del lote</h3><p>Define cómo se identificará y distribuirá.</p></div><span className="step-badge">01 / 02</span></div><label>Nombre del lote<input value={code} onChange={e => setCode(e.target.value)} /></label><label>Cantidad de hojas<div className="number-control"><button onClick={() => setSheets(Math.max(100, sheets - 100))}>−</button><input type="number" min="100" max="200000" value={sheets} onChange={e => setSheets(Math.min(200000, Math.max(100, Number(e.target.value))))} /><button onClick={() => setSheets(Math.min(200000, sheets + 100))}>+</button></div><small className="helper">Mínimo 100 · máximo 200.000 · se crearán {sheets.toLocaleString('es-EC')} hojas / {(sheets * 4).toLocaleString('es-EC')} cartones</small></label><div className="two-fields"><label>Hojas por bloque<input value="40 hojas" disabled /></label><label>Formato<input value="5 × 5 · 75 bolillas" disabled /></label></div><div className="option-row"><div className="toggle active"><span /></div><div><b>Evitar cartones duplicados</b><small>Validación activa durante la generación</small></div></div><div className="option-row"><div className="toggle active"><span /></div><div><b>Crear archivos por bloque</b><small>PDF, ZIP y manifiesto CSV/JSON</small></div></div>{error && <div className="error-box">{error}</div>}<button className="primary wide" onClick={generate} disabled={progress > 0 && progress < 100}>{progress > 0 && progress < 100 ? 'Generando cartones…' : done ? 'Generación completada' : 'Generar lote real'} <Icon name={done ? 'check' : 'arrow'} /></button>{done && <div className="download-actions"><button className="ghost" onClick={downloadZip}><Icon name="download" /> Descargar ZIP</button><button className="ghost" onClick={() => triggerDownload(new Blob([blocksToJson(generated)], { type: 'application/json' }), `${code.toUpperCase()}-manifest.json`)}>JSON</button></div>}</section><section className="panel preview-panel"><div className="panel-heading"><div><h3>Vista previa</h3><p>Así se verá una hoja de distribución.</p></div><span className="preview-tag">PDF / ZIP</span></div><div className="sheet-preview"><div className="sheet-head"><b>{code.toUpperCase()}-H000001</b><span>BLOQUE {code.toUpperCase()}-001</span></div><div className="mini-cards">{[0,1,2,3].map(i => <MiniCard key={i} offset={i * 3} />)}</div><div className="sheet-foot"><span>4 cartones · centro libre</span><span>Hoja 1 de {sheets.toLocaleString('es-EC')}</span></div></div>{progress > 0 && <div className="progress-box"><div><b>{progress === 100 ? 'Lote listo para descargar' : 'Generando hojas…'}</b><span>{progress}% completado</span></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div></div>}<div className="generation-note"><Icon name="lock" /><span>La generación ya crea cartones reales en esta versión. Para 200.000 hojas se moverá a un trabajador de servidor en la siguiente fase.</span></div></section></div><div className="next-step"><span><Icon name="check" /> {done ? `${generated.length} bloques creados correctamente` : 'Generación lista para ejecutar'}</span><button className="text-button" onClick={() => setView('blocks')}>Ver mis bloques <Icon name="arrow" /></button></div></div>
}

function MiniCard({ offset }: { offset: number }) { return <div className="mini-card"><div className="mini-title"><span>B</span><span>I</span><span>N</span><span>G</span><span>O</span></div>{Array.from({ length: 25 }, (_, i) => <span key={i} className={i === 12 ? 'free' : ''}>{i === 12 ? '★' : ((i * 7 + offset * 3) % 74) + 1}</span>)}</div> }

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

function Blocks({ blocks: initialBlocks, setView, onUpdate }: { blocks: BingoBlock[]; setView: (view: View) => void; onUpdate?: (code: string, patch: Partial<BingoBlock>) => void }) { const [blocks, setBlocks] = useState(initialBlocks); const [downloading, setDownloading] = useState(''); const [query, setQuery] = useState(''); const [statusFilter, setStatusFilter] = useState<'Todos' | BingoBlock['status']>('Todos'); const [distributorFilter, setDistributorFilter] = useState('Todos'); const [deliveryBlock, setDeliveryBlock] = useState<BingoBlock | null>(null); const [deliveryDistributor, setDeliveryDistributor] = useState(''); const [deliveryNotes, setDeliveryNotes] = useState(''); const applyUpdate = (code: string, patch: Partial<BingoBlock>) => { setBlocks(current => current.map(block => block.code === code ? { ...block, ...patch } : block)); if (onUpdate) onUpdate(code, patch); else { try { const stored: BingoBlock[] = JSON.parse(localStorage.getItem('bps-blocks') ?? '[]'); localStorage.setItem('bps-blocks', JSON.stringify(stored.map(block => block.code === code ? { ...block, ...patch } : block))) } catch { /* storage unavailable */ } } }; const download = (block: BingoBlock) => { setDownloading(block.code); triggerDownload(new Blob([createBlockPdf(block)], { type: 'application/pdf' }), `${block.code}.pdf`); applyUpdate(block.code, { status: 'Descargado' }); appendAudit('DESCARGA_BLOQUE', `Bloque ${block.code} descargado`); window.setTimeout(() => setDownloading(''), 700) }; const openDelivery = (block: BingoBlock) => { setDeliveryBlock(block); setDeliveryDistributor(block.distributor ?? ''); setDeliveryNotes(block.notes ?? '') }; const confirmDelivery = () => { if (!deliveryBlock || !deliveryDistributor.trim()) return; const recipient = deliveryDistributor.trim(); applyUpdate(deliveryBlock.code, { status: 'Entregado', distributor: recipient, notes: deliveryNotes.trim(), deliveredAt: new Date().toISOString() }); appendAudit('ENTREGA_BLOQUE', `Bloque ${deliveryBlock.code} entregado a ${recipient}`); setDeliveryBlock(null); setDeliveryDistributor(''); setDeliveryNotes('') }; const downloadAll = async () => { if (!blocks.length) return; setDownloading('all'); const blob = await createBlocksZip(blocks); triggerDownload(blob, 'bingo-promax-studio-bloques.zip'); appendAudit('DESCARGA_LOTE', `${blocks.length} bloques descargados en ZIP`); setDownloading('') }; const distributors = Array.from(new Set(blocks.map(block => block.distributor).filter((value): value is string => Boolean(value)))).sort(); const visibleBlocks = blocks.filter(block => { const normalized = query.trim().toLowerCase(); const matchesQuery = !normalized || [block.code, block.range, block.distributor ?? '', block.notes ?? ''].some(value => value.toLowerCase().includes(normalized)); const matchesStatus = statusFilter === 'Todos' || block.status === statusFilter; const matchesDistributor = distributorFilter === 'Todos' || (block.distributor ?? 'Sin asignar') === distributorFilter; return matchesQuery && matchesStatus && matchesDistributor }); const totalSheets = blocks.reduce((total, block) => total + block.pages, 0); const deliveredSheets = blocks.filter(block => block.status === 'Entregado').reduce((total, block) => total + block.pages, 0); return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">DISTRIBUCIÓN</div><h1>Bloques bajo control.</h1><p className="muted">Cada bloque contiene hasta 40 hojas y 160 cartones listos para entregar.</p></div><div className="game-buttons"><button className="ghost" onClick={downloadAll} disabled={!blocks.length || downloading !== ''}><Icon name="download" /> {downloading === 'all' ? 'Preparando ZIP…' : 'Descargar todo'}</button><button className="primary" onClick={() => setView('generator')}><Icon name="plus" /> Nuevo lote</button></div></div><div className="stats-grid compact-stats"><StatCard label="Bloques disponibles" value={String(blocks.length)} detail="Listos para descargar" accent="#f5c84b" icon="layers" /><StatCard label="Hojas en inventario" value={totalSheets.toLocaleString('es-EC')} detail="Todos los estados" accent="#6ee7d1" icon="grid" /><StatCard label="Cartones entregados" value={(deliveredSheets * 4).toLocaleString('es-EC')} detail={`${deliveredSheets.toLocaleString('es-EC')} hojas entregadas`} accent="#bda1ff" icon="download" /></div><section className="panel distribution-toolbar"><label><span>Buscar bloque</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Código, rango o nota…" /></label><label><span>Estado</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'Todos' | BingoBlock['status'])}><option>Todos</option><option>Listo</option><option>Descargado</option><option>Entregado</option></select></label><label><span>Distribuidor</span><select value={distributorFilter} onChange={event => setDistributorFilter(event.target.value)}><option>Todos</option>{distributors.map(distributor => <option key={distributor}>{distributor}</option>)}<option>Sin asignar</option></select></label><div className="filter-result"><b>{visibleBlocks.length}</b><span>de {blocks.length} bloques</span></div></section><section className="panel table-panel"><div className="panel-heading"><div><div className="eyebrow">INVENTARIO DE DISTRIBUCIÓN</div><h3>Todos los bloques</h3></div><span className="preview-tag">{blocks.length ? 'GENERACIÓN LOCAL' : 'SIN LOTES'}</span></div>{visibleBlocks.length ? <div className="table-wrap"><table><thead><tr><th>Bloque</th><th>Rango de hojas</th><th>Contenido</th><th>Creado</th><th>Distribuidor</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{visibleBlocks.map(block => <tr key={block.code}><td><b className="code-cell">{block.code}</b></td><td>{block.range}</td><td>{block.pages} hojas <span className="muted-inline">· {block.pages * 4} cartones</span></td><td>{new Date(block.createdAt).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{block.distributor ?? 'Sin asignar'}{block.deliveredAt && <small className="table-subline">{new Date(block.deliveredAt).toLocaleDateString('es-EC')}{block.notes ? ` · ${block.notes}` : ''}</small>}</td><td><span className={`status ${block.status === 'Entregado' ? 'entregado' : 'listo'}`}>{block.status}</span></td><td><div className="table-actions"><button className="icon-button" title="Descargar PDF" onClick={() => download(block)}><Icon name="download" /></button>{block.status !== 'Entregado' && <button className="ghost compact" onClick={() => openDelivery(block)}>Entregar</button>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><span>▤</span><b>{blocks.length ? 'No hay coincidencias' : 'Aún no tienes bloques generados'}</b><p>{blocks.length ? 'Prueba con otro código, estado o distribuidor.' : 'Genera tu primer lote para ver aquí las hojas y sus archivos.'}</p>{!blocks.length && <button className="primary" onClick={() => setView('generator')}>Crear primer lote <Icon name="arrow" /></button>}</div>}</section>{deliveryBlock && <DeliveryModal block={deliveryBlock} distributor={deliveryDistributor} notes={deliveryNotes} setDistributor={setDeliveryDistributor} setNotes={setDeliveryNotes} onClose={() => setDeliveryBlock(null)} onConfirm={confirmDelivery} />}</div> }

function PatternEditor({ initial, onClose, onSave }: { initial: Pattern; onClose: () => void; onSave: (pattern: Pattern) => void }) { const [draft, setDraft] = useState(initial); const toggleCell = (index: number) => setDraft(current => ({ ...current, cells: current.cells.includes(index) ? current.cells.filter(cell => cell !== index) : [...current.cells, index].sort((a, b) => a - b) })); return <div className="modal-backdrop"><section className="pattern-editor"><div className="panel-heading"><div><div className="eyebrow">EDITOR VISUAL 5 × 5</div><h3>{initial.id ? 'Editar patrón' : 'Crear patrón'}</h3><p>Selecciona las casillas que deben completarse.</p></div><button className="icon-button" onClick={onClose}>×</button></div><div className="editor-layout"><div className="editor-grid">{Array.from({ length: 25 }, (_, index) => <button className={draft.cells.includes(index) ? 'selected' : ''} key={index} onClick={() => toggleCell(index)}>{index === 12 ? '★' : ''}</button>)}</div><div className="editor-fields"><label>Nombre<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>Grupo<select value={draft.group} onChange={event => setDraft({ ...draft, group: event.target.value })}><option>Clásicos</option><option>Letras</option><option>Números</option><option>Especiales</option><option>Personalizados</option></select></label><label>Color<input type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label><label>Descripción<textarea value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label><div className="editor-actions"><button className="ghost" onClick={onClose}>Cancelar</button><button className="primary" disabled={!draft.name.trim() || draft.cells.length === 0} onClick={() => onSave({ ...draft, id: draft.id || `${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}` })}>Guardar patrón</button></div></div></div></section></div> }
function Patterns() {
  const [patterns, setPatterns] = useState<Pattern[]>(readPatternCatalog)
  const [editing, setEditing] = useState<Pattern | null>(null)
  useEffect(() => {
    let active = true
    void loadStudioPatterns().then(remote => {
      if (!active || !remote.length) return
      const local = readPatternCatalog()
      const merged = local.map(pattern => remote.find(item => item.id === pattern.id) ?? pattern)
      remote.filter(item => !local.some(pattern => pattern.id === item.id)).forEach(pattern => merged.push(pattern))
      setPatterns(merged)
    }).catch(() => { /* Local catalog remains available offline. */ })
    return () => { active = false }
  }, [])
  const update = (items: Pattern[]) => { setPatterns(items); localStorage.setItem('bps-patterns', JSON.stringify(items)); void syncStudioPatterns(items).catch(() => { /* Local catalog remains available offline. */ }) }
  const toggle = (id: string) => update(patterns.map(item => item.id === id ? { ...item, active: !item.active } : item))
  const save = (pattern: Pattern) => { const next = patterns.some(item => item.id === pattern.id) ? patterns.map(item => item.id === pattern.id ? pattern : item) : [...patterns, pattern]; update(next); setEditing(null) }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">BIBLIOTECA DE FIGURAS</div><h1>Administra tus patrones.</h1><p className="muted">Selecciona las figuras que podrás usar en cada partida.</p></div><button className="primary" onClick={() => setEditing({ id: '', name: '', description: 'Patrón personalizado creado por el estudio.', group: 'Personalizados', color: '#f5c84b', cells: [12], active: false })}><Icon name="plus" /> Crear patrón</button></div><div className="pattern-summary"><div><span className="summary-orb">✦</span><div><b>{patterns.filter(p => p.active).length} patrones habilitados</b><small>{patterns.length} patrones disponibles</small></div></div><div className="summary-chips"><span>● {patterns.filter(p => p.group === 'Clásicos').length} clásicos</span><span>✦ {patterns.filter(p => p.group === 'Letras').length} letras</span><span>⌘ {patterns.filter(p => p.group === 'Especiales').length} especiales</span></div></div><div className="pattern-grid">{patterns.map(pattern => <PatternCard key={pattern.id} pattern={pattern} onToggle={() => toggle(pattern.id)} onEdit={() => setEditing(pattern)} />)}</div>{editing && <PatternEditor initial={editing} onClose={() => setEditing(null)} onSave={save} />}</div>
}
function PatternCard({ pattern, onToggle, onEdit }: { pattern: Pattern; onToggle: () => void; onEdit: () => void }) { return <article className={`pattern-card ${pattern.active ? 'pattern-active' : ''}`}><div className="pattern-card-head"><PatternIcon pattern={pattern} /><span className={`pattern-status ${pattern.active ? 'enabled' : ''}`}>{pattern.active ? 'En juego' : 'Inactivo'}</span></div><h3>{pattern.name}</h3><p>{pattern.description}</p><div className="pattern-actions"><button className={`outline-action ${pattern.active ? 'gold' : ''}`} onClick={onToggle}>{pattern.active ? 'Deshabilitar' : 'Habilitar'}</button><button className="icon-button" onClick={onEdit} title="Editar patrón">⌕</button></div><footer><span>{pattern.group}</span><span>{pattern.active ? 'Disponible' : 'Pausado'}</span></footer></article> }
function PatternIcon({ pattern }: { pattern: Pattern }) { return <div className="pattern-icon" style={{ '--pattern-color': pattern.color } as CSSProperties}>{Array.from({ length: 25 }, (_, i) => <i className={pattern.cells.includes(i) ? 'on' : ''} key={i} />)}</div> }

function Games({ selectedPatterns, setSelectedPatterns, blocks }: { selectedPatterns: string[]; setSelectedPatterns: (ids: string[]) => void; blocks: BingoBlock[] }) { const [started, setStarted] = useState(false); const [drawn, setDrawn] = useState<number[]>([]); const [winner, setWinner] = useState(''); const activePatterns = seedPatterns.filter(p => p.active); const card = blocks[0]?.sheets[0]?.cards[0] ?? demoCard; const togglePattern = (id: string) => setSelectedPatterns(selectedPatterns.includes(id) ? selectedPatterns.filter(p => p !== id) : [...selectedPatterns, id]); const draw = (n: number) => { if (!started || drawn.includes(n)) return; const next = [...drawn, n]; setDrawn(next); const drawnSet = new Set(next); const completed = activePatterns.filter(pattern => selectedPatterns.includes(pattern.id) && isPatternComplete(card, pattern.cells, drawnSet)); if (completed.length) setWinner(completed.map(pattern => pattern.name).join(' · ')) }; const reset = () => { setDrawn([]); setStarted(false); setWinner('') }; return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">PARTIDA ACTUAL <span className="live-pill">● {started ? 'EN JUEGO' : 'LISTA'}</span></div><h1>{started ? 'Partida en movimiento.' : 'Prepara una nueva partida.'}</h1><p className="muted">Elige los patrones y registra cada bolilla desde el teclado visual.</p></div><div className="game-buttons"><button className="ghost" onClick={reset}>Reiniciar</button><button className="primary" onClick={() => setStarted(true)}><Icon name="play" /> {started ? 'Partida activa' : 'Comenzar partida'}</button></div></div>{winner && <div className="winner-alert"><span>🏆</span><div><b>Patrón completado: {winner}</b><small>La tarjeta de demostración {card.id} cumple la modalidad seleccionada.</small></div><button className="ghost" onClick={() => setWinner('')}>Ocultar</button></div>}<div className="game-layout"><section className="panel game-board"><div className="game-board-head"><div><div className="eyebrow">CONTROL DE BOLILLAS</div><h3>Registrar nueva bolilla</h3></div><span className="no-duplicates"><Icon name="check" /> Sin duplicados</span></div><div className="latest-row"><div className="last-ball"><small>ÚLTIMA BOLILLA</small><b>{drawn.at(-1) ?? '—'}</b><span>{drawn.length ? 'Registrada ahora' : 'Esperando inicio'}</span></div><div className="draw-history"><div className="history-title"><b>Historial de bolillas</b><span>{drawn.length} / 75</span></div><div className="history-balls">{drawn.slice(-12).reverse().map(n => <i key={n}>{n}</i>)}</div><div className="progress-track"><div style={{ width: `${(drawn.length / 75) * 100}%` }} /></div></div></div><div className="ball-grid">{Array.from({ length: 75 }, (_, i) => i + 1).map(n => <button className={drawn.includes(n) ? 'drawn' : ''} key={n} onClick={() => draw(n)} disabled={!started}>{n}</button>)}</div></section><aside className="panel selected-patterns"><div className="eyebrow">PATRONES EN JUEGO</div><h3>Selecciona las figuras</h3><p>Se verificarán automáticamente con cada bolilla.</p><div className="pattern-select-list">{activePatterns.map(pattern => <button className={`select-pattern ${selectedPatterns.includes(pattern.id) ? 'chosen' : ''}`} key={pattern.id} onClick={() => togglePattern(pattern.id)}><PatternIcon pattern={pattern} /><span><b>{pattern.name}</b><small>{pattern.group}</small></span><span className="check-circle">{selectedPatterns.includes(pattern.id) ? '✓' : ''}</span></button>)}</div><div className="selected-count">{selectedPatterns.length} patrones seleccionados · {blocks.length ? 'cartones cargados' : 'modo demostración'}</div></aside></div></div> }

function CompleteGames({ selectedPatterns, setSelectedPatterns, blocks }: { selectedPatterns: string[]; setSelectedPatterns: (ids: string[]) => void; blocks: BingoBlock[] }) {
  const [started, setStarted] = useState(false)
  const [drawn, setDrawn] = useState<number[]>([])
  const [search, setSearch] = useState('')
  const [winner, setWinner] = useState<{ pattern: Pattern; cards: BingoCard[] } | null>(null)
  const [winnerHistory, setWinnerHistory] = useState<{ pattern: string; count: number; ball: number }[]>([])
  const [gameId, setGameId] = useState(() => localStorage.getItem('bps-current-game') ?? crypto.randomUUID())
  const [gameHydrated, setGameHydrated] = useState(false)
  useEffect(() => {
    let active = true
    void loadStudioGame().then((remote) => {
      if (!active) return
      if (remote) {
        setGameId(remote.id)
        localStorage.setItem('bps-current-game', remote.id)
        setStarted(remote.status === 'running')
        setDrawn(remote.drawnNumbers)
        setWinnerHistory(remote.winnerHistory)
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
  }, [setSelectedPatterns])
  useEffect(() => {
    if (!gameHydrated) return
    const game: StudioGame = {
      id: gameId,
      name: 'Partida Studio',
      date: new Date().toISOString().slice(0, 10),
      prize: '',
      status: started ? 'running' : 'ready',
      activePatternIds: selectedPatterns,
      drawnNumbers: drawn,
      winnerHistory,
      notes: 'Partida administrada desde Bingo ProMax Studio.',
    }
    localStorage.setItem('bps-current-game', gameId)
    localStorage.setItem('bps-current-game-state', JSON.stringify(game))
    void syncStudioGame(game).catch(() => { /* Local game state remains available offline. */ })
  }, [drawn, gameHydrated, gameId, selectedPatterns, started, winnerHistory])
  const activePatterns = readPatternCatalog().filter(pattern => pattern.active)
  const cards = blocks.flatMap(block => block.sheets.flatMap(sheet => sheet.cards))
  const gameCards = cards.length ? cards : [demoCard]
  const searchedCard = search.trim() ? gameCards.find(card => card.id.toLowerCase().includes(search.trim().toLowerCase())) : gameCards[0]
  const togglePattern = (id: string) => setSelectedPatterns(selectedPatterns.includes(id) ? selectedPatterns.filter(patternId => patternId !== id) : [...selectedPatterns, id])
  const evaluate = (nextDrawn: number[]) => {
    const drawnSet = new Set(nextDrawn)
    for (const pattern of activePatterns) {
      if (!selectedPatterns.includes(pattern.id)) continue
      const matches = gameCards.filter(card => isPatternComplete(card, pattern.cells, drawnSet))
      if (matches.length) return { pattern, cards: matches }
    }
    return null
  }
  const draw = (number: number) => {
    if (!started || drawn.includes(number)) return
    const next = [...drawn, number]
    setDrawn(next)
    const result = evaluate(next)
    if (result) {
      setWinner(result)
      setWinnerHistory(history => history.some(item => item.pattern === result.pattern.name && item.ball === number) ? history : [...history, { pattern: result.pattern.name, count: result.cards.length, ball: number }])
    }
  }
  const reset = () => { setDrawn([]); setStarted(false); setWinner(null); setWinnerHistory([]) }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">PARTIDA ACTUAL <span className="live-pill">● {started ? 'EN JUEGO' : 'LISTA'}</span></div><h1>{started ? 'Partida en movimiento.' : 'Prepara una nueva partida.'}</h1><p className="muted">Cada bolilla se evalúa contra {gameCards.length.toLocaleString('es-EC')} cartones cargados.</p></div><div className="game-buttons"><button className="ghost" onClick={reset}>Reiniciar</button><button className="primary" onClick={() => setStarted(true)}><Icon name="play" /> {started ? 'Partida activa' : 'Comenzar partida'}</button></div></div>{winner && <div className="winner-alert"><span>🏆</span><div><b>{winner.pattern.name}: {winner.cards.length.toLocaleString('es-EC')} ganador(es)</b><small>Detectados en la bolilla {drawn.at(-1)} · {winner.cards.slice(0, 3).map(card => card.id).join(' · ')}{winner.cards.length > 3 ? ' · …' : ''}</small></div><button className="ghost" onClick={() => setWinner(null)}>Ocultar</button></div>}<div className="game-layout"><section className="panel game-board"><div className="game-board-head"><div><div className="eyebrow">CONTROL DE BOLILLAS</div><h3>Registrar nueva bolilla</h3></div><span className="no-duplicates"><Icon name="check" /> Sin duplicados</span></div><div className="latest-row"><div className="last-ball"><small>ÚLTIMA BOLILLA</small><b>{drawn.at(-1) ?? '—'}</b><span>{drawn.length ? 'Registrada ahora' : 'Esperando inicio'}</span></div><div className="draw-history"><div className="history-title"><b>Historial de bolillas</b><span>{drawn.length} / 75</span></div><div className="history-balls">{drawn.slice(-12).reverse().map(number => <i key={number}>{number}</i>)}</div><div className="progress-track"><div style={{ width: `${(drawn.length / 75) * 100}%` }} /></div></div></div><div className="ball-grid">{Array.from({ length: 75 }, (_, index) => index + 1).map(number => <button className={drawn.includes(number) ? 'drawn' : ''} key={number} onClick={() => draw(number)} disabled={!started}>{number}</button>)}</div>{winnerHistory.length > 0 && <div className="winner-history"><div className="eyebrow">VALIDACIONES DE ESTA PARTIDA</div>{winnerHistory.map(item => <div className="winner-history-row" key={`${item.pattern}-${item.ball}`}><span>✓</span><b>{item.pattern}</b><small>{item.count} ganador(es) · bolilla {item.ball}</small></div>)}</div>}</section><aside className="panel selected-patterns"><div className="eyebrow">PATRONES EN JUEGO</div><h3>Selecciona las figuras</h3><p>Se verificarán contra todos los cartones cargados.</p><div className="pattern-select-list">{activePatterns.map(pattern => <button className={`select-pattern ${selectedPatterns.includes(pattern.id) ? 'chosen' : ''}`} key={pattern.id} onClick={() => togglePattern(pattern.id)}><PatternIcon pattern={pattern} /><span><b>{pattern.name}</b><small>{pattern.group}</small></span><span className="check-circle">{selectedPatterns.includes(pattern.id) ? '✓' : ''}</span></button>)}</div><div className="card-search"><label>Buscar cartón<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Ej. BP-2026-001-H000001" /></label>{searchedCard && <div className="searched-card"><div><b>{searchedCard.id}</b><small>{cards.length ? 'Cartón cargado desde el bloque' : 'Cartón de demostración'}</small></div><span>{drawn.length} bolillas</span></div>}</div><div className="selected-count">{selectedPatterns.length} patrones · {gameCards.length.toLocaleString('es-EC')} cartones en juego</div></aside></div></div>
}

function Integration({ blocks, onImport }: { blocks: BingoBlock[]; onImport: (blocks: BingoBlock[]) => void }) { const [message, setMessage] = useState(''); const [error, setError] = useState(''); const exportJson = () => triggerDownload(new Blob([blocksToProMaxJson(blocks)], { type: 'application/json' }), 'bingo-promax-package-v1-1.json'); const exportCsv = () => triggerDownload(new Blob([blocksToProMaxCsv(blocks)], { type: 'text/csv;charset=utf-8' }), 'bingo-promax-package-v1-1.csv'); const importFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const imported = parseProMaxPackage(String(reader.result)); onImport(imported); setError(''); setMessage(`${imported.length} bloques importados y listos para usar.`) } catch (importError) { setMessage(''); setError(importError instanceof Error ? importError.message : 'No se pudo importar el paquete.') } }; reader.readAsText(file); event.target.value = '' }; return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">PUENTE DE DATOS</div><h1>Conecta con ProMax.</h1><p className="muted">Intercambia cartones y bloques con Bingo Control ProMax usando un formato versionado.</p></div><div className="secure-badge"><Icon name="check" /> Esquema de intercambio v1.1</div></div><div className="integration-status"><div className="status-orb">↔</div><div><b>Modo de integración local</b><p>Exporta desde Studio e importa el paquete en Bingo Control ProMax. La API remota se conectará en la fase de backend.</p></div><span className="status listo">Preparado</span></div><div className="integration-grid"><section className="panel integration-panel"><div className="eyebrow">EXPORTAR A PROMAX</div><h3>Paquete de cartones</h3><p>Incluye campañas, bloques, hojas, códigos y cartones con el formato real de ProMax.</p><div className="export-actions"><button className="primary" onClick={exportJson} disabled={!blocks.length}><Icon name="download" /> Exportar JSON</button><button className="ghost" onClick={exportCsv} disabled={!blocks.length}><Icon name="download" /> Exportar CSV</button></div><small className="helper">{blocks.length ? `${blocks.length} bloques · ${blocks.reduce((sum, block) => sum + block.pages, 0)} hojas · ${blocks.reduce((sum, block) => sum + block.pages * 4, 0)} cartones` : 'Genera un lote para habilitar la exportación.'}</small></section><section className="panel integration-panel"><div className="eyebrow">IMPORTAR DESDE PROMAX</div><h3>Recibir un paquete</h3><p>Importa un JSON v1.0 o v1.1 generado por Bingo ProMax Studio.</p><label className="file-drop"><input type="file" accept="application/json,.json" onChange={importFile} /><span>＋ Seleccionar paquete JSON</span><small>El archivo se valida antes de incorporarse al inventario local.</small></label>{message && <div className="success-box">✓ {message}</div>}{error && <div className="error-box">{error}</div>}</section></div><section className="panel contract-panel"><div className="panel-heading"><div><div className="eyebrow">CONTRATO DE DATOS</div><h3>Formato compatible con Bingo Control ProMax</h3><p>Los nombres siguen las interfaces y acciones de su API de estado.</p></div><span className="preview-tag">v1.1</span></div><div className="contract-table"><div><code>game</code><span>Partida lista para importar</span></div><div><code>cards[].number</code><span>Numeración del cartón</span></div><div><code>cards[].grid</code><span>Matriz plana de 25 valores; 0 representa centro libre</span></div><div><code>cards[].layout</code><span>Diseño classic-5x5 con filas, columnas y celdas</span></div><div><code>cards[].sourcePage</code><span>Página original dentro de la hoja PDF</span></div><div><code>blocks[].code</code><span>Código único del bloque de 40 hojas</span></div></div></section><section className="api-roadmap"><span>API futura</span><b>POST /api/integration/promax/import</b><b>GET /api/integration/promax/blocks/:code</b><b>POST /api/integration/promax/games</b></section></div> }

function Users({ currentMember }: { currentMember: StudioMember | null }) {
  const [members, setMembers] = useState<StudioMember[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<StudioMember['role']>('operator')
  const [permissions, setPermissions] = useState<Record<string, boolean>>({ dashboard: true, blocks: true, games: true })
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
    const member: StudioMember = { email: normalized, role, active: true, permissions: role === 'operator' ? permissions : {} }
    try { await saveStudioMember(member); setMembers(current => current.some(item => item.email === normalized) ? current.map(item => item.email === normalized ? member : item) : [...current, member]); appendAudit('ALTA_USUARIO', `${normalized} agregado como ${role}`); setOpen(false); setEmail('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo guardar el usuario. Ejecuta la migración de Supabase primero.') } finally { setBusy(false) }
  }
  return <div className="page-content"><div className="page-intro"><div><div className="eyebrow">CONTROL DE ACCESO</div><h1>Usuarios autorizados.</h1><p className="muted">Los desarrolladores controlan administradores y operadores con permisos separados.</p></div><button className="primary" disabled={!canManage} onClick={() => { setError(''); setPermissions({ dashboard: true, blocks: true, games: true }); setOpen(true) }}><Icon name="plus" /> Agregar usuario</button></div><section className="panel table-panel"><div className="panel-heading"><div><h3>Equipo del estudio</h3><p>Las dos cuentas iniciales tienen rol desarrollador.</p></div><span className="preview-tag">{members.length} CUENTAS</span></div><div className="user-list">{members.map(member => <UserRow key={member.email} member={member} />)}</div></section>{open && <div className="modal-backdrop"><section className="modal small-modal"><header><div><span className="eyebrow">NUEVO ACCESO</span><h2>Agregar usuario</h2></div><button className="icon-button" onClick={() => setOpen(false)} type="button">×</button></header><div className="form-stack"><label>Correo<input autoFocus type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="operador@dominio.com" /></label><label>Rol<select value={role} onChange={event => setRole(event.target.value as StudioMember['role'])}><option value="operator">Operador</option><option value="admin">Administrador</option></select></label>{role === 'operator' && <div className="permission-picker"><span className="eyebrow">MÓDULOS PERMITIDOS</span>{permissionOptions.map(option => <label key={option.id}><input type="checkbox" checked={permissions[option.id] === true} onChange={event => setPermissions(current => ({ ...current, [option.id]: event.target.checked }))} />{option.label}</label>)}</div>}{error && <div className="error-box">{error}</div>}</div><footer><button className="ghost" onClick={() => setOpen(false)} type="button">Cancelar</button><button className="primary" disabled={busy} onClick={() => void save()} type="button">{busy ? 'Guardando…' : 'Guardar acceso'}</button></footer></section></div>}</div>
}
function UserRow({ member }: { member: StudioMember }) { return <div className="user-row"><div className="avatar">{member.email.slice(0, 2).toUpperCase()}</div><div><b>{member.email}</b><span>{member.role === 'developer' ? 'Desarrollador' : member.role === 'admin' ? 'Administrador' : 'Operador'}</span></div><span className={`status ${member.active ? 'listo' : 'entregado'}`}>{member.active ? 'Activo' : 'Inactivo'}</span><button className="icon-button" disabled title="Los cambios se administran desde la siguiente versión de permisos">⋯</button></div> }

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
  const [authReady, setAuthReady] = useState(false)
  const [view, setView] = useState<View>('dashboard')
  const [blocks, setBlocks] = useState<BingoBlock[]>(() => { try { return JSON.parse(localStorage.getItem('bps-blocks') ?? '[]') } catch { return [] } })
  const [selectedPatterns, setSelectedPatterns] = useState(['full', 'letter-a'])

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
    let active = true
    void loadPersistedBlocks().then((stored) => {
      if (!active || !stored.length) return
      setBlocks((current) => current.length ? current : stored)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (currentMember && !canAccessView(currentMember, view)) setView('dashboard')
  }, [currentMember, view])

  if (!authReady) return <main className="login-shell"><section className="login-card"><Logo /><p className="muted">Verificando la sesión segura…</p></section></main>
  if (!email) return <Login onLogin={async (value) => { const { error } = await supabase.auth.signInWithOtp({ email: value, options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } }); if (error) throw error }} />

  const logout = async () => { await supabase.auth.signOut(); localStorage.removeItem('bps-email'); setEmail(null) }
  const replaceBlocks = (nextBlocks: BingoBlock[]) => { setBlocks(nextBlocks); void persistBlocks(nextBlocks) }
  const onGenerated = (nextBlocks: BingoBlock[]) => replaceBlocks(nextBlocks)
  const onImported = (importedBlocks: BingoBlock[]) => { setBlocks(current => { const merged = [...current]; importedBlocks.forEach(block => { const index = merged.findIndex(existing => existing.code === block.code); if (index >= 0) merged[index] = block; else merged.push(block) }); void persistBlocks(merged); return merged }) }
  const onBlockUpdate = (code: string, patch: Partial<BingoBlock>) => { setBlocks(current => { const next = current.map(block => block.code === code ? { ...block, ...patch } : block); const updated = next.find(block => block.code === code); void persistBlocks(next, false); if (updated) void syncStudioBlock(updated).catch(() => { /* Offline delivery remains local. */ }); return next }) }
  const content = { dashboard: <Dashboard setView={setView} blocks={blocks} />, generator: <Generator onGenerated={onGenerated} setView={setView} />, blocks: <Blocks blocks={blocks} setView={setView} onUpdate={onBlockUpdate} />, games: <CompleteGames selectedPatterns={selectedPatterns} setSelectedPatterns={setSelectedPatterns} blocks={blocks} />, patterns: <Patterns />, integration: <Integration blocks={blocks} onImport={onImported} />, users: <Users currentMember={currentMember} />, audit: <Audit /> }[view]
  return <div className="app-shell"><Sidebar view={view} setView={setView} email={email} blocks={blocks} member={currentMember} /><main className="main-area"><Topbar view={view} onLogout={() => void logout()} />{content}</main></div>
}

createRoot(document.getElementById('root')!).render(<App />)
