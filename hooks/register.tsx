import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HudAgent, HudBreakdown, HudLimit, HudPeer, HudStats, HudUsage } from '../types'

// ── State ────────────────────────────────────────────────────────────────

const INITIAL_STATS: HudStats = {
  startedAt: 0,
  turns: 0,
  working: false,
  turnStartedAt: 0,
  lastTurnTools: 0,
  turnTools: 0,
  toolCalls: 0,
  lastAction: '',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  celebrateUntil: 0,
}

const frame = atom({ plugin: 'spark-hud', key: 'frame' } as const, 0)
const now = atom({ plugin: 'spark-hud', key: 'now' } as const, 0)
const isExpanded = atom({ plugin: 'spark-hud', key: 'isExpanded' } as const, false)
const usage = atom({ plugin: 'spark-hud', key: 'usage' } as const, null)
const breakdown = atom({ plugin: 'spark-hud', key: 'breakdown' } as const, null)
const agents = atom({ plugin: 'spark-hud', key: 'agents' } as const, [])
const peers = atom({ plugin: 'spark-hud', key: 'peers' } as const, [])
const themeShift = atom({ plugin: 'spark-hud', key: 'themeShift' } as const, 0)
const stats = atom({ plugin: 'spark-hud', key: 'stats' } as const, INITIAL_STATS)

const PANE = 'spark-hud-panel'
const TICK_MS = 220
const CELEBRATE_MS = 2600
const PEER_TTL_MS = 10 * 60 * 1000

// ── Animación del logo ───────────────────────────────────────────────────

const SPARKS = ['✻', '✼', '✽', '✾', '✽', '✼']
const DANCE = ['┗(*)┓', '┏(*)┛', '┗(*)┛', '┏(*)┓']
const PARTY = ['\\(*)/', '─(*)─', '\\(*)/', '/(*)\\']
const NOTES = ['♪', '♫', ' ', '♫']
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type Mood = 'idle' | 'dance' | 'party' | 'sweat'

function logo(f: number, mood: Mood): string {
  const spark = SPARKS[f % SPARKS.length] ?? '✻'
  if (mood === 'dance') return `${NOTES[f % 4]}${(DANCE[Math.floor(f / 2) % 4] ?? '').replace('*', spark)}`
  if (mood === 'party') return `✦${(PARTY[f % 4] ?? '').replace('*', spark)}`
  if (mood === 'sweat') return ` (✻;) `
  return '  (✻) '
}

// ── Formato ──────────────────────────────────────────────────────────────

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined) return '—'
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`
}



const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
  spend_limit: 'gasto',
}

const LIMIT_SPAN: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
  seven_day_opus: 7 * 24 * 3600_000,
  seven_day_sonnet: 7 * 24 * 3600_000,
}

type Pace = { resetIn?: number; expected?: number; runsOutIn?: number }

function pace(limit: HudLimit, at: number): Pace {
  const resetAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!Number.isFinite(resetAt)) return {}
  const resetIn = resetAt - at
  const span = LIMIT_SPAN[limit.kind]
  if (span === undefined) return { resetIn }
  const elapsed = Math.max(0, span - resetIn)
  const expected = (elapsed / span) * 100
  let runsOutIn: number | undefined
  if (elapsed > span * 0.03 && limit.percentUsed > 0) {
    const rate = limit.percentUsed / elapsed
    const left = (100 - limit.percentUsed) / rate
    if (left < resetIn) runsOutIn = left
  }
  return { resetIn, expected, runsOutIn }
}

function describeTool(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p
  const cut = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `${tool}: ${cut(str('command').replace(/\s+/g, ' '))}`
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool} ${base(str('file_path') || str('notebook_path'))}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${cut(str('pattern'), 32)}`
    case 'WebFetch':
      return `WebFetch ${cut(str('url').replace(/^https?:\/\//, ''), 40)}`
    case 'WebSearch':
      return `Busca "${cut(str('query'), 36)}"`
    case 'Agent':
    case 'Task':
      return `lanza agente: ${cut(str('description'), 36)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
  }
}

// ── Lectura de figuras del engine ────────────────────────────────────────

async function refreshUsage($: EngineInterface): Promise<HudUsage> {
  const [u, model] = await Promise.all([$.session.usage(), $.session.model()])
  const next: HudUsage = {
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    ctxPercent: u.context.percent,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    costUsd: u.cost?.usd,
    model,
  }
  await update($, usage, () => next)
  return next
}

async function refreshBreakdown($: EngineInterface, columns: number) {
  const u = await $.session.usage({ breakdown: 'summary', columns })
  const b = u.context.breakdown
  if (!b) return
  const next: HudBreakdown = {
    categories: b.categories
      .filter(c => !c.isDeferred)
      .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    total: b.totalTokens,
    max: b.rawMaxTokens,
    autoCompactAt: b.autoCompactThreshold,
    isAutoCompact: b.isAutoCompactEnabled,
  }
  await update($, breakdown, () => next)
}

async function refreshAgents($: EngineInterface, at: number) {
  const list = await $.agent.list()
  await update($, agents, prev => {
    const byId = new Map(prev.map(a => [a.id, a]))
    const rows: HudAgent[] = list.map(info => {
      const old = byId.get(info.id)
      return {
        id: info.id,
        name: info.name ?? info.teammateId ?? '',
        type: info.type,
        description: info.description,
        status: info.status,
        lastAction: old?.lastAction ?? '',
        tools: old?.tools ?? 0,
        startedAt: old?.startedAt ?? at,
        updatedAt: old?.updatedAt ?? at,
      }
    })
    // Agentes que ya vimos por sus tool calls pero que la lista aún no nombra.
    for (const a of prev) {
      if (!rows.some(r => r.id === a.id) && at - a.updatedAt < 60_000) rows.push(a)
    }
    return rows
  })
}

// ── Ventanas paralelas (otras sesiones) ─────────────────────────────────

async function peersDir($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/\\/g, '/')}/.claude/spark-hud/sessions` : undefined
}

async function heartbeat($: EngineInterface, myId: string, ended = false) {
  const dir = await peersDir($)
  if (!dir) return
  const [u, s, list, cwd, at] = await Promise.all([
    read($, usage),
    read($, stats),
    read($, agents),
    $.session.cwd(),
    $.clock.now(),
  ])
  const me: HudPeer = {
    id: myId,
    project: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    model: u?.model ?? '',
    ctxPercent: u?.ctxPercent,
    fiveHour: u?.limits.find(l => l.kind === 'five_hour')?.percentUsed,
    working: s.working,
    lastAction: s.lastAction,
    agentsRunning: list.filter(a => a.status === 'running').length,
    updatedAt: at,
    ended,
  }
  await $.fs.write(`${dir}/${myId}.json`, JSON.stringify(me))
}

async function refreshPeers($: EngineInterface, myId: string, at: number) {
  const dir = await peersDir($)
  if (!dir || !(await $.fs.exists(dir))) return
  const entries = await $.fs.list(dir)
  const found: HudPeer[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.name === `${myId}.json` || at - entry.mtimeMs > PEER_TTL_MS) continue
    try {
      const peer = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as HudPeer
      if (!peer.ended) found.push(peer)
    } catch {
      // un archivo a medio escribir: se lee en el próximo ciclo
    }
  }
  found.sort((a, b) => Number(b.working) - Number(a.working) || b.updatedAt - a.updatedAt)
  await update($, peers, () => found)
}

// ── Paletas (rotan cada 15 minutos, sincronizadas entre ventanas) ────────

type Theme = { name: string; stops: string[]; chip: string; text: string }

// Combinaciones sobrias: un neutro oscuro + un solo color de acento, en tres tonos.
const THEMES: Theme[] = [
  { name: 'Negro y rojo', stops: ['#7F1D1D', '#B91C1C', '#E05252'], chip: '#1C1C1C', text: '#E7E5E4' },
  { name: 'Grafito y ámbar', stops: ['#78350F', '#B45309', '#D9A441'], chip: '#1F1D1A', text: '#E7E5E4' },
  { name: 'Pizarra y azul', stops: ['#1E3A5F', '#2F5D8A', '#6C9BC8'], chip: '#1A1F26', text: '#E2E8F0' },
  { name: 'Bosque', stops: ['#1F4D33', '#2F7A4E', '#6BAA75'], chip: '#1A201C', text: '#E3EAE4' },
  { name: 'Tinta y hueso', stops: ['#57534E', '#A8A29E', '#E7E5E4'], chip: '#1C1B1A', text: '#F5F5F4' },
  { name: 'Vino', stops: ['#4C0519', '#881337', '#C2546F'], chip: '#1F1A1C', text: '#F1E7EA' },
]

const THEME_MS = 15 * 60 * 1000
const OK = '#6BAA75'
const WARN = '#D9A441'
const HOT = '#D9534F'
const TRACK = '#2E2E2E'
const MUTED = '#8A8580'

function themeIndex(at: number, shift: number): number {
  return (((Math.floor(at / THEME_MS) + shift) % THEMES.length) + THEMES.length) % THEMES.length
}

function hex(c: string): [number, number, number] {
  const h = c.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function lerp(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const a = hex(stops[i] ?? '#FFFFFF')
  const b = hex(stops[i + 1] ?? stops[i] ?? '#FFFFFF')
  const k = x - i
  return `#${[0, 1, 2].map(j => Math.round(a[j]! + (b[j]! - a[j]!) * k).toString(16).padStart(2, '0')).join('')}`
}

/** Posición 0..1 que va y vuelve, desplazada por el frame: el degradé "fluye". */
function wave(i: number, n: number, shift: number): number {
  const p = (((i / Math.max(1, n)) + shift) % 1 + 1) % 1
  return p < 0.5 ? p * 2 : 2 - p * 2
}

function statusColor(pct: number): string {
  return pct >= 85 ? HOT : pct >= 60 ? WARN : OK
}

// ── Dibujo ───────────────────────────────────────────────────────────────

type Els = ReturnType<EngineInterface['ui']['resolve']>

type View = {
  f: number
  at: number
  u: HudUsage | null
  b: HudBreakdown | null
  s: HudStats
  ag: HudAgent[]
  pe: HudPeer[]
  t: Theme
}

async function view($: EngineInterface): Promise<View> {
  const [f, at, u, b, s, ag, pe, shift] = await Promise.all([
    read($, frame),
    read($, now),
    read($, usage),
    read($, breakdown),
    read($, stats),
    read($, agents),
    read($, peers),
    read($, themeShift),
  ])
  return { f, at, u, b, s, ag, pe, t: THEMES[themeIndex(at, shift)] ?? THEMES[0]! }
}

function moodOf(v: View): Mood {
  if (v.s.working) return 'dance'
  if (v.at < v.s.celebrateUntil) return 'party'
  if ((v.u?.ctxPercent ?? 0) >= 85) return 'sweat'
  return 'idle'
}

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const TWINKLE = ['✦', '✧', '⋆', '·', ' ', '·', '⋆', '✧']

/** Texto con un degradé que se desplaza con el frame. */
function Grad(E: Els, text: string, v: View) {
  const { Text } = E
  const chars = [...text]
  return (
    <Text bold>
      {chars.map((ch, i) => (
        <Text color={lerp(v.t.stops, wave(i, chars.length - 1, v.f * 0.03))}>{ch}</Text>
      ))}
    </Text>
  )
}

/** Barra con degradé, precisión de 1/8 de celda y un brillo que la recorre. */
function GradBar(E: Els, pct: number, width: number, v: View, shimmer: boolean) {
  const { Text } = E
  const clamped = Math.max(0, Math.min(100, pct))
  const exact = (clamped / 100) * width
  const full = Math.floor(exact)
  const part = PARTIAL[Math.floor((exact - full) * 8)] ?? ''
  const stops = clamped >= 85 ? [WARN, HOT] : clamped >= 60 ? [v.t.stops[0]!, WARN] : v.t.stops
  const glow = shimmer ? v.f % (full + 6) : -1
  const at = (i: number) => lerp(stops, width <= 1 ? 0 : i / (width - 1))
  const cells = []
  for (let i = 0; i < full; i += 1) {
    cells.push(<Text color={i === glow ? v.t.text : at(i)}>█</Text>)
  }
  if (part) {
    cells.push(
      <Text color={at(full)} backgroundColor={TRACK}>
        {part}
      </Text>,
    )
  }
  const rest = width - full - (part ? 1 : 0)
  return (
    <Text>
      {cells}
      {rest > 0 ? <Text color={TRACK}>{'█'.repeat(rest)}</Text> : null}
    </Text>
  )
}

function Chip(E: Els, label: string, v: View, color?: string) {
  const { Text } = E
  return (
    <Text backgroundColor={v.t.chip} color={color ?? v.t.text} bold>
      {` ${label} `}
    </Text>
  )
}

function Gauge(E: Els, label: string, pct: number, width: number, v: View, suffix?: string) {
  const { Text } = E
  return (
    <Text>
      {Chip(E, label, v)}
      <Text> </Text>
      {GradBar(E, pct, width, v, v.s.working)}
      <Text bold color={statusColor(pct)}> {String(Math.round(pct)).padStart(2, ' ')}%</Text>
      {suffix ? <Text color={MUTED}>{suffix}</Text> : null}
    </Text>
  )
}

function Logo(E: Els, v: View) {
  const { Text } = E
  const mood = moodOf(v)
  const chars = [...logo(v.f, mood)]
  const sparkle = [0, 1, 2].map(i => TWINKLE[(v.f + i * 3) % TWINKLE.length] ?? ' ')
  return (
    <Text bold>
      {chars.map((ch, i) => (
        <Text
          color={
            mood === 'sweat'
              ? HOT
              : SPARKS.includes(ch)
                ? lerp(v.t.stops, wave(v.f, 11, 0))
                : lerp(v.t.stops, i / Math.max(1, chars.length - 1))
          }
        >
          {ch}
        </Text>
      ))}
      {sparkle.map((ch, i) => (
        <Text color={v.t.stops[(i + v.f) % v.t.stops.length]}>{ch}</Text>
      ))}
    </Text>
  )
}

/** Línea separadora con degradé animado y un título incrustado. */
function Rule(E: Els, cols: number, v: View, title: string, right: string) {
  const { Text } = E
  const head = `──╼ ${title} ╾`
  const tail = right ? `╼ ${right} ╾──` : '──'
  const fill = Math.max(2, cols - [...head].length - [...tail].length)
  const chars = [...`${head}${'─'.repeat(fill)}${tail}`]
  const titleEnd = 4 + [...title].length
  const speed = v.s.working ? -0.015 : -0.004
  return (
    <Text wrap="truncate-end">
      {chars.map((ch, i) => (
        <Text color={lerp(v.t.stops, wave(i, chars.length - 1, v.f * speed))} bold={i >= 4 && i < titleEnd}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}

function tips(v: View): string[] {
  const out: string[] = []
  const ctx = v.u?.ctxPercent ?? 0
  if (ctx >= 85) out.push('Contexto casi lleno: /compact ahora, o /clear si cambiás de tarea.')
  else if (ctx >= 60) out.push('Contexto al 60%+: pensá en /compact al terminar este paso.')
  for (const l of v.u?.limits ?? []) {
    const p = pace(l, v.at)
    if (p.runsOutIn !== undefined)
      out.push(`Al ritmo actual el límite ${LIMIT_LABEL[l.kind] ?? l.kind} se agota en ~${fmtDur(p.runsOutIn)}: usá /model sonnet para lo simple.`)
  }
  const cacheBase = v.s.input + v.s.cacheRead + v.s.cacheWrite
  if (cacheBase > 50_000 && v.s.cacheRead / cacheBase < 0.5)
    out.push('Cache hit bajo: evitá editar CLAUDE.md o cambiar de modelo a mitad de sesión.')
  if (v.ag.filter(a => a.status === 'running').length >= 4)
    out.push('Muchos agentes en paralelo: cada uno consume del mismo límite 5h.')
  return out
}

function AgentLine(E: Els, a: HudAgent, v: View, i: number) {
  const { Text } = E
  const isRunning = a.status === 'running' || a.status === 'pending'
  const isBad = a.status === 'failed' || a.status === 'killed'
  const icon = isRunning ? SPIN[(v.f + i) % SPIN.length] : a.status === 'completed' ? '✔' : isBad ? '✘' : '◦'
  const tint = v.t.stops[i % v.t.stops.length] ?? v.t.text
  return (
    <Text wrap="truncate-end">
      <Text color={isRunning ? tint : a.status === 'completed' ? OK : isBad ? HOT : MUTED}> {icon} </Text>
      <Text bold color={tint}>
        {a.name || a.type}
      </Text>
      <Text color={MUTED}> · {a.description}</Text>
      {a.lastAction ? <Text color={v.t.text}> → {a.lastAction}</Text> : null}
      <Text color={MUTED}>
        {'  '}
        {a.tools}⚒{isRunning ? ` ${fmtDur(v.at - a.startedAt)}` : ''}
      </Text>
    </Text>
  )
}

function PeerLine(E: Els, p: HudPeer, v: View, i: number) {
  const { Text } = E
  const isStale = v.at - p.updatedAt > 45_000
  const tint = v.t.stops[(i + 1) % v.t.stops.length] ?? v.t.text
  return (
    <Text wrap="truncate-end">
      <Text color={p.working ? tint : MUTED}> {p.working ? SPIN[(v.f + i * 2) % SPIN.length] : '◦'} </Text>
      <Text bold color={tint}>
        {p.project}
      </Text>
      <Text color={MUTED}> · {p.model}</Text>
      {p.ctxPercent !== undefined ? <Text color={statusColor(p.ctxPercent)}> ctx {p.ctxPercent}%</Text> : null}
      {p.agentsRunning > 0 ? <Text color={v.t.text}> · {p.agentsRunning} agentes</Text> : null}
      {p.lastAction ? <Text color={v.t.text}> → {p.lastAction}</Text> : null}
      {isStale ? <Text color={MUTED}> (sin señal {fmtDur(v.at - p.updatedAt)})</Text> : null}
    </Text>
  )
}

function Header(E: Els, text: string, v: View, count?: string) {
  const { Text } = E
  return (
    <Text>
      {Grad(E, `◆ ${text}`, v)}
      {count ? <Text color={MUTED}> {count}</Text> : null}
    </Text>
  )
}

function compactCard(E: Els, v: View, cols: number, onToggle: () => void) {
  const { Box, Text, Button } = E
  const barW = cols >= 130 ? 12 : cols >= 100 ? 9 : cols >= 80 ? 6 : 4
  const ctxPct = v.u?.ctxPercent ?? 0
  const five = v.u?.limits.find(l => l.kind === 'five_hour')
  const week = v.u?.limits.find(l => l.kind === 'seven_day')
  const running = v.ag.filter(a => a.status === 'running' || a.status === 'pending').length
  const busyPeers = v.pe.filter(p => p.working).length
  const fiveReset = five ? pace(five, v.at).resetIn : undefined
  const model = (v.u?.model ?? '…').replace(/^claude-/, '')

  return (
    <Box flexDirection="column">
      {Rule(E, cols, v, 'SPARK HUD', v.t.name)}
      <Box flexDirection="row" gap={2}>
        {Logo(E, v)}
        {Gauge(E, 'CTX', ctxPct, barW, v, v.u?.ctxTokens !== undefined && cols >= 100 ? ` ${fmtTokens(v.u.ctxTokens)}/${fmtTokens(v.u.ctxWindow)}` : '')}
        {five ? Gauge(E, '5H', five.percentUsed, barW, v, fiveReset !== undefined && cols >= 110 ? ` ↻${fmtDur(fiveReset)}` : '') : null}
        {week && cols >= 85 ? Gauge(E, '7D', week.percentUsed, Math.max(3, barW - 3), v) : null}
      </Box>
      <Box flexDirection="row" gap={2}>
        <Text>
          <Text color={v.t.stops[1]} bold>
            ⬢{' '}
          </Text>
          <Text color={v.t.text}>{model}</Text>
        </Text>
        <Text>
          <Text color={v.t.stops[2]} bold>
            ${' '}
          </Text>
          <Text color={v.t.text}>{fmtUsd(v.u?.costUsd).replace('$', '')}</Text>
        </Text>
        <Text>
          <Text color={running > 0 ? v.t.stops[2] : MUTED} bold>
            {running > 0 ? SPIN[v.f % SPIN.length] : '⚙'}{' '}
          </Text>
          <Text color={v.t.text}>
            {running}/{v.ag.length} agentes
          </Text>
        </Text>
        {v.pe.length > 0 ? (
          <Text>
            <Text color={busyPeers > 0 ? v.t.stops[0] : MUTED} bold>
              ◫{' '}
            </Text>
            <Text color={v.t.text}>
              {v.pe.length} vent{busyPeers > 0 ? ` · ${busyPeers}▶` : ''}
            </Text>
          </Text>
        ) : null}
        {v.s.working && v.s.lastAction && cols >= 90 ? (
          <Text wrap="truncate-end" color={MUTED}>
            → <Text color={v.t.text}>{v.s.lastAction}</Text>
          </Text>
        ) : null}
        <Button key="toggle" plain label="▾ más" onPress={onToggle} />
      </Box>
      {Rule(E, cols, v, `${v.s.turns} turnos · ${fmtDur(v.at - v.s.startedAt)}`, '')}
    </Box>
  )
}

function expandedView(E: Els, v: View, cols: number, $: EngineInterface, onToggle: () => void) {
  const { Box, Text, Button } = E
  const bigW = Math.max(10, Math.min(32, cols - 48))
  const ctxPct = v.u?.ctxPercent ?? 0
  const used = (v.b?.categories ?? []).filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const catMax = Math.max(1, ...used.map(c => c.tokens))
  const cacheBase = v.s.input + v.s.cacheRead + v.s.cacheWrite
  const cacheHit = cacheBase > 0 ? Math.round((v.s.cacheRead / cacheBase) * 100) : undefined
  const running = v.ag.filter(a => a.status === 'running' || a.status === 'pending')
  const shownAgents = [...v.ag].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')).slice(0, 8)
  const advice = tips(v)

  return (
    <Box flexDirection="column">
      {Rule(E, cols, v, 'SPARK HUD', v.t.name)}
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {Logo(E, v)}
          <Text color={v.t.text}>
            {'  '}
            {v.u?.model ?? '…'}
          </Text>
          <Text color={MUTED}>
            {' '}
            · sesión {fmtDur(v.at - v.s.startedAt)} · {v.s.turns} turnos
          </Text>
        </Text>
        <Box flexDirection="row" gap={2}>
          <Button key="theme" plain label="🎨 tema" onPress={() => void update($, themeShift, n => n + 1)} />
          <Button key="panel" plain label="◫ panel" onPress={() => void $.ui.open({ id: PANE, title: 'Spark HUD · agentes' })} />
          <Button key="toggle" plain label="▴ menos" onPress={onToggle} />
        </Box>
      </Box>

      {Header(E, 'CONTEXT WINDOW', v)}
      <Text>
        <Text>{'  '}</Text>
        {GradBar(E, ctxPct, bigW, v, v.s.working)}
        <Text bold color={statusColor(ctxPct)}>
          {' '}
          {ctxPct}%
        </Text>
        <Text color={v.t.text}>
          {'  '}
          {fmtTokens(v.u?.ctxTokens)} / {fmtTokens(v.u?.ctxWindow)}
        </Text>
        <Text color={MUTED}>
          {v.b?.autoCompactAt ? `  · autocompact en ${fmtTokens(v.b.autoCompactAt)}` : v.b && !v.b.isAutoCompact ? '  · autocompact OFF' : ''}
        </Text>
      </Text>
      {used.slice(0, 6).map((c, i) => {
        const w = 14
        const n = Math.max(1, Math.round((c.tokens / catMax) * w))
        return (
          <Text wrap="truncate-end">
            <Text>{'    '}</Text>
            <Text color={v.t.stops[i % v.t.stops.length]}>{'▮'.repeat(n)}</Text>
            <Text color={TRACK}>{'▮'.repeat(w - n)}</Text>
            <Text color={v.t.text}> {fmtTokens(c.tokens).padStart(5, ' ')} </Text>
            <Text color={MUTED}>{c.name}</Text>
          </Text>
        )
      })}

      {Header(E, 'PLAN MAX', v)}
      {(v.u?.limits ?? []).length === 0 ? <Text color={MUTED}>  Sin lectura todavía (llega con la próxima respuesta).</Text> : null}
      {(v.u?.limits ?? []).map(l => {
        const p = pace(l, v.at)
        const diff = p.expected !== undefined ? l.percentUsed - p.expected : undefined
        return (
          <Box flexDirection="column">
            <Text>
              <Text>{'  '}</Text>
              {Chip(E, (LIMIT_LABEL[l.kind] ?? l.kind).toUpperCase().padEnd(9, ' '), v)}
              <Text> </Text>
              {GradBar(E, l.percentUsed, bigW, v, v.s.working)}
              <Text bold color={statusColor(l.percentUsed)}>
                {' '}
                {Math.round(l.percentUsed)}%
              </Text>
              {p.resetIn !== undefined ? <Text color={MUTED}>  ↻ {fmtDur(p.resetIn)}</Text> : null}
            </Text>
            {diff !== undefined ? (
              <Text>
                <Text color={MUTED}>{'              ritmo '}</Text>
                {p.runsOutIn !== undefined ? (
                  <Text color={HOT} bold>
                    ▲ se agota en ~{fmtDur(p.runsOutIn)}, antes del reinicio
                  </Text>
                ) : diff > 5 ? (
                  <Text color={WARN}>▲ {Math.round(diff)}% por encima de lo esperado</Text>
                ) : (
                  <Text color={OK}>▼ holgado ({Math.round(-diff)}% por debajo del ritmo lineal)</Text>
                )}
              </Text>
            ) : null}
          </Box>
        )
      })}

      {Header(E, 'SESIÓN', v)}
      <Text wrap="truncate-end">
        <Text>{'  '}</Text>
        {Chip(E, `$ ${fmtUsd(v.u?.costUsd).replace('$', '')}`, v)}
        <Text> </Text>
        {Chip(E, `⚒ ${v.s.toolCalls}`, v)}
        <Text> </Text>
        {Chip(E, `⏱ ${v.s.lastTurnMs !== undefined ? `${fmtDur(v.s.lastTurnMs)}/${v.s.lastTurnTools}⚒` : '—'}`, v)}
        <Text> </Text>
        {Chip(E, `cache ${cacheHit === undefined ? '—' : `${cacheHit}%`}`, v, cacheHit === undefined ? v.t.text : statusColor(100 - cacheHit))}
        <Text> </Text>
        {Chip(E, `out ${fmtTokens(v.s.output)}`, v)}
      </Text>
      {v.s.working && v.s.lastAction ? (
        <Text wrap="truncate-end">
          <Text color={MUTED}>  ahora </Text>
          <Text color={v.t.text}>{v.s.lastAction}</Text>
          <Text color={MUTED}> ({fmtDur(v.at - v.s.turnStartedAt)})</Text>
        </Text>
      ) : null}

      {Header(E, 'AGENTES', v, `${running.length} activos / ${v.ag.length}`)}
      {v.ag.length === 0 ? <Text color={MUTED}>  Ninguno en esta sesión.</Text> : null}
      {shownAgents.map((a, i) => AgentLine(E, a, v, i))}
      {v.ag.length > shownAgents.length ? <Text color={MUTED}>  … {v.ag.length - shownAgents.length} más en ◫ panel</Text> : null}

      {Header(E, 'OTRAS VENTANAS', v, `${v.pe.length}`)}
      {v.pe.length === 0 ? <Text color={MUTED}>  Ninguna otra sesión con spark-hud abierta.</Text> : null}
      {v.pe.slice(0, 6).map((p, i) => PeerLine(E, p, v, i))}

      {advice.length > 0 ? Header(E, 'TIPS', v) : null}
      {advice.map(t => (
        <Text wrap="truncate-end" color={WARN}>
          {'  ✦ '}
          {t}
        </Text>
      ))}
      {Rule(E, cols, v, `tema ${v.t.name} · cambia cada 15 min`, '')}
    </Box>
  )
}

async function toggle($: EngineInterface, columns?: number) {
  const open = await update($, isExpanded, v => !v)
  if (open) await refreshBreakdown($, columns ?? 100).catch(() => undefined)
}

// ── Registro ─────────────────────────────────────────────────────────────

export const register: Register = on => {
  let myId = ''
  let ticks = 0
  let lastTheme = -1
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    myId = await $.session.id()
    const u = await $.session.usage()
    const at = await $.clock.now()
    await update($, stats, s => ({ ...s, startedAt: u.startedAt }))
    await update($, now, () => at)
    await refreshUsage($).catch(() => undefined)

    await $.command.register({ name: 'hud', description: 'Spark HUD: expandir / contraer el panel sobre el prompt' })
    await $.command.register({ name: 'hud-tema', description: 'Spark HUD: pasar al siguiente tema de colores' })
    await $.command.register({ name: 'hud-panel', description: 'Spark HUD: abrir el panel lateral de agentes y ventanas' })

    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      ticks += 1
      void (async () => {
        const at = await $.clock.now()
        const [s, ag] = await Promise.all([read($, stats), read($, agents)])
        const hasRunning = ag.some(a => a.status === 'running' || a.status === 'pending')
        const isAnimating = s.working || at < s.celebrateUntil || hasRunning
        // rápido mientras trabaja; en reposo, un brillo suave (~1 fps)
        if (isAnimating || ticks % 4 === 0) {
          await update($, frame, f => (f + 1) % 10_000)
          await update($, now, () => at)
        }
        const theme = themeIndex(at, await read($, themeShift))
        if (lastTheme !== -1 && theme !== lastTheme) $.ui.toast(`🎨 Spark HUD · tema ${THEMES[theme]?.name ?? ''}`)
        lastTheme = theme
        // cada ~1s mientras algo corre: agentes
        if ((s.working || hasRunning) && ticks % 5 === 0) await refreshAgents($, at).catch(() => undefined)
        // cada ~5s: latido para otras ventanas y lectura de ellas
        if (ticks % 23 === 0) {
          await heartbeat($, myId).catch(() => undefined)
          await refreshPeers($, myId, at).catch(() => undefined)
        }
        // cada ~30s en reposo: relojes de reinicio
        if (!isAnimating && ticks % 136 === 0) {
          await update($, now, () => at)
          await refreshUsage($).catch(() => undefined)
        }
      })().catch(() => undefined)
    })

    await heartbeat($, myId).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    if (myId) await heartbeat($, myId, true).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    await toggle($)
    return { text: (await read($, isExpanded)) ? 'Spark HUD expandido.' : 'Spark HUD contraído.' }
  })

  on('command.run', { command: 'hud-tema' }, async $ => {
    await update($, themeShift, n => n + 1)
    const at = await $.clock.now()
    return { text: `Tema: ${THEMES[themeIndex(at, await read($, themeShift))]?.name ?? ''}` }
  })

  on('command.run', { command: 'hud-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Spark HUD · agentes' })
    return { text: opened.isPlaced ? 'Panel de Spark HUD abierto.' : 'Panel listo: se muestra al ensanchar la terminal (o en modo fullscreen).' }
  })

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, stats, s => ({ ...s, working: true, turnStartedAt: at, turnTools: 0, lastAction: 'pensando…' }))
    await update($, now, () => at)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const action = describeTool(String(e.tool), e as unknown as Record<string, unknown>)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        list.some(a => a.id === id)
          ? list.map(a => (a.id === id ? { ...a, lastAction: action, tools: a.tools + 1, updatedAt: at } : a))
          : [...list, { id, name: '', type: 'agente', description: '', status: 'running', lastAction: action, tools: 1, startedAt: at, updatedAt: at }],
      )
    } else {
      await update($, stats, s => ({ ...s, lastAction: action, turnTools: s.turnTools + 1, toolCalls: s.toolCalls + 1 }))
    }
    const result = await next(e)
    if (e.tool === 'Agent') await refreshAgents($, await $.clock.now()).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, lastAction: 'terminó', updatedAt: at } : a)))
      await refreshAgents($, at).catch(() => undefined)
      return next(e)
    }
    const u = e.usage
    await update($, stats, s => ({
      ...s,
      working: false,
      turns: s.turns + 1,
      lastTurnMs: e.durationMs,
      lastTurnTools: s.turnTools,
      lastAction: e.isAborted ? 'interrumpido' : 'listo',
      input: s.input + (u?.input_tokens ?? 0),
      output: s.output + (u?.output_tokens ?? 0),
      cacheRead: s.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: s.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      celebrateUntil: e.isAborted ? 0 : at + CELEBRATE_MS,
    }))
    await update($, now, () => at)
    await refreshUsage($).catch(() => undefined)
    await refreshAgents($, at).catch(() => undefined)
    if (await read($, isExpanded)) await refreshBreakdown($, 100).catch(() => undefined)
    if (myId) await heartbeat($, myId).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($).catch(() => undefined)
    const ctx = e.context.percent ?? 0
    for (const l of e.rateLimits) {
      if (e.changed.includes('rateLimits') && (l.percentUsed >= 90 || l.percentUsed === 75)) {
        $.ui.toast(`✻ Límite ${LIMIT_LABEL[l.kind] ?? l.kind} al ${Math.round(l.percentUsed)}%`)
      }
    }
    if (e.changed.includes('context') && ctx >= 85) $.ui.toast(`✻ Contexto al ${ctx}%: buen momento para /compact`)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const E = $.ui.resolve(e)
    const v = await view($)
    const cols = e.props.bodyColumns
    const columns = e.viewport?.columns
    const onToggle = () => void toggle($, columns)
    return (await read($, isExpanded)) ? expandedView(E, v, cols, $, onToggle) : compactCard(E, v, cols, onToggle)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e)
    const { Box, Text } = E
    const v = await view($)
    const cols = e.props.bodyColumns
    return (
      <Box flexDirection="column">
        {compactCard(E, v, cols, () => void toggle($))}
        <Text bold color="claude">
          Agentes de esta sesión <Text dimColor>({v.ag.length})</Text>
        </Text>
        {v.ag.length === 0 ? <Text dimColor>  Ninguno todavía.</Text> : null}
        {v.ag.map((a, i) => AgentLine(E, a, v, i))}
        <Text bold color="claude">
          Otras ventanas <Text dimColor>({v.pe.length})</Text>
        </Text>
        {v.pe.length === 0 ? <Text dimColor>  Abrí otra sesión de Claude Code: aparece acá sola.</Text> : null}
        {v.pe.map((p, i) => PeerLine(E, p, v, i))}
      </Box>
    )
  })
}

