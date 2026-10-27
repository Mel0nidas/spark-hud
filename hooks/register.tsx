import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { HudAgent, HudBreakdown, HudLimit, HudPeer, HudStats, HudUsage, HudViewRow } from '../types'

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
const themeIdx = atom({ plugin: 'spark-hud', key: 'theme' } as const, 0)
const viewerAgent = atom({ plugin: 'spark-hud', key: 'viewerAgent' } as const, null)
const viewerRows = atom({ plugin: 'spark-hud', key: 'viewerRows' } as const, [])
const stats = atom({ plugin: 'spark-hud', key: 'stats' } as const, INITIAL_STATS)
const motionAtom = atom({ plugin: 'spark-hud', key: 'motion' } as const, 'full')

const PANE = 'spark-hud-panel'
const VIEWER = 'spark-hud-agent'
const PEER_TTL_MS = 10 * 60 * 1000

type Motion = 'full' | 'calm' | 'off'

/** Milliseconds to the next tick: fast only while something moves, slow at rest. */
function tickDelay(motion: Motion, isAnimating: boolean): number {
  if (motion === 'off') return isAnimating ? 1000 : 15_000
  if (motion === 'calm') return isAnimating ? 500 : 2000
  return isAnimating ? 220 : 1000
}

// ── Avatar: pixel art, 11×8 square pixels, two to a cell ─────────────────
//
// Every state and every move between states is drawn from the same pixels:
//   quiet ──prompt──▶ wakes (crouch, hop) ──▶ dances ──turn done──▶ jumps, bursts into
//   sparks, a thumbs-up rises, shines, sinks, and the mascot pops back up and blinks.
//   An interrupted turn shakes its head; a nearly full context makes it sweat.
// Codes: a light, b body, c shade, k eyes, w glint, s spark, n note, d sweat, '.' empty.

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const AVATAR_W = 11
const AVATAR_H = 8
const AVATAR_GAP = 3
const BLANK_PX = '.'.repeat(AVATAR_W)

// Claude's mascot: tall eyes, open arms, four legs; three free rows above for hops and notes
const MASCOT_PX = [
  '...........',
  '...........',
  '..abbbbbc..',
  '..bkbbbkc..',
  '..bkbbbkc..',
  'abbbbbbbbbc',
  '..bbbbbbc..',
  '..b.b.c.c..',
]

// A thumbs-up: c sleeve, b skin, a light edge, c knuckle lines
const THUMB_PX = [
  '.....ab....',
  '....abbc...',
  '....abbc...',
  'cc.aabbbbb.',
  'ccaabbcccc.',
  'ccabbbbbbbc',
  'ccabbbcccc.',
  'cc.cbbbbbc.',
]

// the burst between mascot and thumb: a flash, then sparks flying out
const FLASH_PX = ['...........', '...........', '.....s.....', '....sws....', '...swwws...', '....sws....', '.....s.....', '...........']
const SPARKS_PX = ['...........', '.s.......s.', '...........', '.....w.....', 's...w.w...s', '.....w.....', '...........', '.s.......s.']
const EMBERS_PX = ['s.........s', '...........', '...........', '...........', '...........', '...........', '...........', 's.........s']

// The done sequence, in ms after the turn ended; ticks come every 220 ms, so each step shows
const DONE_MS = 5500
const THUMB_UNTIL = 4200
const WAKE_MS = 450
const SHAKE_MS = 900
// at rest the eyes wander now and then (a tick a second: a blink would read as a nap)
const IDLE_EYES = ['open', 'open', 'open', 'open', 'open', 'right', 'right', 'open', 'open', 'open', 'left', 'left'] as const

type Eyes = 'open' | 'closed' | 'right' | 'left'
type Pose = { eyes?: Eyes; arms?: 'out' | 'up' | 'down'; legs?: 0 | 1 }

function mascot(pose: Pose = {}): string[] {
  const px = MASCOT_PX.map(r => [...r])
  const set = (x: number, y: number, c: string) => {
    const row = px[y]
    if (row && x >= 0 && x < AVATAR_W) row[x] = c
  }
  const eyes = pose.eyes ?? 'open'
  if (eyes === 'closed') {
    set(3, 3, 'b')
    set(7, 3, 'b')
  } else if (eyes !== 'open') {
    const d = eyes === 'right' ? 1 : -1
    for (const y of [3, 4]) {
      set(3, y, 'b')
      set(7, y, 'b')
      set(3 + d, y, 'k')
      set(7 + d, y, 'k')
    }
  }
  if (pose.arms === 'up' || pose.arms === 'down') {
    px[5] = [...'..bbbbbbc..']
    const [y1, y2] = pose.arms === 'up' ? [4, 3] : [6, 7]
    set(1, y1, 'a')
    set(0, y2, 'a')
    set(9, y1, 'c')
    set(10, y2, 'c')
  }
  if (pose.legs === 1) px[7] = [...'.b.b...c.c.']
  return px.map(r => r.join(''))
}

/** The sprite moved by (dx, dy), clipped to the canvas. */
function shift(px: string[], dx: number, dy: number): string[] {
  return Array.from({ length: AVATAR_H }, (_, y) => {
    const src = px[y - dy]
    return src ? Array.from({ length: AVATAR_W }, (_, x) => src[x - dx] ?? '.').join('') : BLANK_PX
  })
}

/** `top` drawn over `base`: its empty pixels let the base show. */
function over(base: string[], top: string[]): string[] {
  return base.map((row, y) => [...row].map((c, x) => (top[y]?.[x] && top[y]![x] !== '.' ? top[y]![x]! : c)).join(''))
}

/** One pixel set, where the canvas is empty. */
function dot(px: string[], x: number, y: number, c: string): string[] {
  return px.map((row, j) => (j === y ? [...row].map((p, i) => (i === x && p === '.' ? c : p)).join('') : row))
}

/** The thumbs-up after the turn ended: rises through the embers, shines, holds, sinks. */
function doneFrame(f: number, t: number): string[] {
  if (t < 300) return shift(mascot({ arms: 'up', eyes: 'closed' }), 0, -2)
  if (t < 550) return FLASH_PX
  if (t < 800) return SPARKS_PX
  if (t < 1050) return over(EMBERS_PX, shift(THUMB_PX, 0, 4))
  if (t < 1300) return shift(THUMB_PX, 0, 1)
  if (t < THUMB_UNTIL) {
    // a diagonal band of light sweeps across once, then a spark twinkles beside the thumb
    const band = Math.floor((t - 1300) / 150)
    let px = THUMB_PX.map((row, y) => [...row].map((c, x) => (c !== '.' && x + (y >> 1) === band ? 'w' : c)).join(''))
    if (band > 14 && f % 3 !== 2) {
      const [x, y] = ([[9, 0], [10, 1], [8, 0], [10, 2]] as const)[f % 4]!
      px = dot(px, x, y, 's')
    }
    return px
  }
  if (t < 4450) return shift(THUMB_PX, 0, 2)
  if (t < 4700) return shift(THUMB_PX, 0, 5)
  if (t < 4950) return shift(mascot(), 0, 4)
  if (t < 5200) return shift(mascot(), 0, 1)
  return mascot({ eyes: 'closed' })
}

/** The avatar's pixels for this frame: its state, or the move between two states. */
function avatarPixels(v: View): string[] {
  const { s, at, f, still } = v
  if (s.working) {
    const woke = at - s.turnStartedAt
    if (still) return mascot()
    if (woke < 220) return shift(mascot({ eyes: 'closed', arms: 'down' }), 0, 1)
    if (woke < WAKE_MS) return shift(mascot({ arms: 'up' }), 0, -2)
    const beat = f % 4
    const isUp = beat % 2 === 0
    let px = shift(mascot({ arms: isUp ? 'up' : 'down', legs: isUp ? 0 : 1, eyes: beat === 3 ? 'closed' : 'open' }), 0, isUp ? -1 : 0)
    // a two-pixel note on one side, then the other
    px = dot(px, beat < 2 ? 0 : 10, 1, 'n')
    px = dot(px, beat < 2 ? 1 : 9, 0, 'n')
    return px
  }
  const doneFor = s.doneAt ? at - s.doneAt : Infinity
  if (doneFor < DONE_MS) return still ? (doneFor < THUMB_UNTIL ? THUMB_PX : mascot()) : doneFrame(f, doneFor)
  const abortFor = s.abortAt ? at - s.abortAt : Infinity
  if (abortFor < SHAKE_MS && !still) return shift(mascot({ eyes: 'closed' }), [-1, 1, -1, 1][Math.floor(abortFor / 220)] ?? 0, 0)
  const px = mascot({ eyes: still ? 'open' : IDLE_EYES[f % IDLE_EYES.length] })
  if ((v.u?.ctxPercent ?? 0) < 85) return px
  // nearly full: a drop runs down beside the head
  const [x, y] = ([[9, 2], [9, 3], [10, 4]] as const)[f % 3]!
  return dot(px, x, y, 'd')
}

function PixelArt(E: Els, px: string[], paint: (code: string) => string | undefined) {
  const { Box, Text } = E
  const rows: RenderElement[] = []
  for (let y = 0; y < px.length; y += 2) {
    const cellsInRow: RenderElement[] = []
    for (let x = 0; x < AVATAR_W; x += 1) {
      const top = paint(px[y]?.[x] ?? '.')
      const bottom = paint(px[y + 1]?.[x] ?? '.')
      if (!top && !bottom) cellsInRow.push(<Text> </Text>)
      else if (!bottom) cellsInRow.push(<Text color={top}>▀</Text>)
      else if (!top) cellsInRow.push(<Text color={bottom}>▄</Text>)
      else if (top === bottom) cellsInRow.push(<Text color={top}>█</Text>)
      else
        cellsInRow.push(
          <Text color={top} backgroundColor={bottom}>
            ▀
          </Text>,
        )
    }
    rows.push(<Text>{cellsInRow}</Text>)
  }
  return (
    <Box flexDirection="column" width={AVATAR_W} flexShrink={0}>
      {rows}
    </Box>
  )
}

// ── Formatting ──────────────────────────────────────────────────────────────

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

/** Time to a limit's reset; a reading past its reset says so until the next one arrives. */
function fmtReset(ms: number): string {
  return ms <= 0 ? 'resetting' : fmtDur(ms)
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
  spend_limit: 'spend',
}

function limitLabel(kind: string): string {
  return LIMIT_LABEL[kind] ?? kind.replace(/_/g, ' ')
}

const LIMIT_SPAN: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
  seven_day_opus: 7 * 24 * 3600_000,
  seven_day_sonnet: 7 * 24 * 3600_000,
}

type Pace = { resetIn?: number; expected?: number; runsOutIn?: number; isOut?: boolean }

function pace(limit: HudLimit, at: number): Pace {
  const resetAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!Number.isFinite(resetAt)) return {}
  // a reading older than its reset: the window has rolled over, nothing to forecast
  const resetIn = Math.max(0, resetAt - at)
  if (limit.percentUsed >= 100) return { resetIn, isOut: true }
  const span = LIMIT_SPAN[limit.kind]
  if (span === undefined || resetIn === 0) return { resetIn }
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
      return `Search "${cut(str('query'), 36)}"`
    case 'Agent':
    case 'Task':
      return `spawn agent: ${cut(str('description'), 36)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
  }
}

// ── Reading the engine's figures ────────────────────────────────────────

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

/** Agent names and tasks can hold line breaks; a row shows them on one line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

async function refreshAgents($: EngineInterface, at: number) {
  const list = await $.agent.list()
  await update($, agents, prev => {
    const byId = new Map(prev.map(a => [a.id, a]))
    const rows: HudAgent[] = list.map(info => {
      const old = byId.get(info.id)
      return {
        id: info.id,
        name: oneLine(info.name ?? info.teammateId ?? ''),
        type: oneLine(info.type),
        description: oneLine(info.description ?? ''),
        status: info.status,
        lastAction: old?.lastAction ?? '',
        tools: old?.tools ?? 0,
        startedAt: old?.startedAt ?? at,
        updatedAt: old?.updatedAt ?? at,
        ...(old?.ctxTokens !== undefined ? { ctxTokens: old.ctxTokens } : {}),
        ...(old?.model ? { model: old.model } : {}),
      }
    })
    return rows
  })
}

// ── Parallel windows (other sessions) ──────────────────────────────────

// Each window keeps one small file in a shared folder. The engine offers no delete, so a
// session takes over the file of one that ended (or went silent) instead of adding its own:
// the folder holds about as many files as windows ever ran at once.

const TOMBSTONE = '{"ended":true}'
const SLOT_NAME = /^[A-Za-z0-9_-]{1,80}\.json$/
const MAX_PEERS = 8
const MAX_PEER_BYTES = 4096
// control characters and bidi overrides: a peer file must not be able to drive the terminal
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/** The folder, under CLAUDE_CONFIG_DIR when set, else ~/.claude. */
async function peersDir($: EngineInterface): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const base = config || (home ? `${home}/.claude` : undefined)
  return base ? `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/spark-hud/sessions` : undefined
}

/** Tool names other windows may see: MCP tools say only 'MCP', so no server name leaks. */
function toolLabel(tool: string): string {
  return tool.startsWith('mcp__') ? 'MCP' : clip(tool.replace(UNSAFE_CHARS, ''), 24)
}

/**
 * A peer file comes from any process that can write the folder: only plain, bounded
 * values pass, and anything else drops the file.
 */
function parsePeer(text: string, at: number): HudPeer | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined // half-written, or not ours: read again on the next cycle
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const str = (x: unknown, n: number) => (typeof x === 'string' ? clip(x.replace(UNSAFE_CHARS, '').trim(), n) : '')
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  const id = str(o.id, 80)
  const updatedAt = num(o.updatedAt)
  if (o.ended === true || !id || updatedAt === undefined) return undefined
  const ctx = num(o.ctxPercent)
  return {
    id,
    project: str(o.project, 40) || '?',
    model: str(o.model, 40),
    ...(ctx !== undefined ? { ctxPercent: Math.max(0, Math.min(100, Math.round(ctx))) } : {}),
    working: o.working === true,
    activity: str(o.activity, 24),
    agentsRunning: Math.max(0, Math.min(99, Math.floor(num(o.agentsRunning) ?? 0))),
    updatedAt: Math.min(updatedAt, at),
  }
}

type PeerLink = { id: string; slot: string; lastText: string; lastWriteAt: number }

/**
 * Picks the file this session writes, and blanks every stale one on the way: files that
 * spark-hud 0.4 left behind held the start of Bash commands, and no file is deleted.
 */
async function claimSlot($: EngineInterface, link: PeerLink, at: number) {
  link.slot = `${link.id}.json`
  const dir = await peersDir($)
  if (!dir || !(await $.fs.exists(dir))) return
  let reuse = ''
  for (const entry of (await $.fs.list(dir)).slice(0, 500)) {
    if (entry.kind !== 'file' || !SLOT_NAME.test(entry.name)) continue
    const isStale = at - entry.mtimeMs > PEER_TTL_MS
    const isTomb = entry.size === TOMBSTONE.length
    if (isStale && !isTomb) await $.fs.write(`${dir}/${entry.name}`, TOMBSTONE).catch(() => undefined)
    if (!reuse && (isStale || isTomb)) reuse = entry.name
  }
  if (reuse) link.slot = reuse
}

async function heartbeat($: EngineInterface, link: PeerLink, ended = false) {
  const dir = await peersDir($)
  if (!dir || !link.slot) return
  const at = await $.clock.now()
  let text = TOMBSTONE
  if (!ended) {
    const [u, s, list, cwd] = await Promise.all([read($, usage), read($, stats), read($, agents), $.session.cwd()])
    const me: Omit<HudPeer, 'updatedAt'> = {
      id: link.id,
      project: cwd.split(/[\\/]/).filter(Boolean).pop() ?? '',
      model: u?.model ?? '',
      ...(u?.ctxPercent !== undefined ? { ctxPercent: u.ctxPercent } : {}),
      working: s.working,
      activity: s.working ? (s.lastTool ?? '') : '',
      agentsRunning: list.filter(a => a.status === 'running').length,
    }
    text = JSON.stringify(me)
    // unchanged: write only often enough to stay inside the others' freshness window
    if (text === link.lastText && at - link.lastWriteAt < 60_000) return
  }
  await $.fs.write(`${dir}/${link.slot}`, ended ? TOMBSTONE : `${text.slice(0, -1)},"updatedAt":${at}}`)
  link.lastText = text
  link.lastWriteAt = at
}

async function refreshPeers($: EngineInterface, link: PeerLink, at: number) {
  const dir = await peersDir($)
  if (!dir || !(await $.fs.exists(dir))) return
  const found: HudPeer[] = []
  for (const entry of (await $.fs.list(dir)).slice(0, 500)) {
    if (entry.kind !== 'file' || !SLOT_NAME.test(entry.name)) continue
    if (at - entry.mtimeMs > PEER_TTL_MS || entry.size > MAX_PEER_BYTES || entry.size <= TOMBSTONE.length) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')
    const peer = parsePeer(text, at)
    if (entry.name === link.slot) {
      // another session took the same old file at the same moment: move to a file of our own
      if (peer && peer.id !== link.id) link.slot = `${link.id}.json`
      continue
    }
    if (peer && peer.id !== link.id && !found.some(p => p.id === peer.id)) found.push(peer)
  }
  found.sort((a, b) => Number(b.working) - Number(a.working) || b.updatedAt - a.updatedAt)
  await update($, peers, () => found.slice(0, MAX_PEERS))
}

// ── Palettes (fixed until you change them; kept between sessions) ─────

type Theme = { name: string; stops: string[]; chip: string; text: string }

// Calm pairings: a dark neutral plus one accent color, in three shades.
const THEMES: Theme[] = [
  { name: 'Claude', stops: ['#A8553A', '#D97757', '#EBA285'], chip: '#1F1B19', text: '#EDE6E1' },
  { name: 'Black & Red', stops: ['#7F1D1D', '#B91C1C', '#E05252'], chip: '#1C1C1C', text: '#E7E5E4' },
  { name: 'Graphite & Amber', stops: ['#78350F', '#B45309', '#D9A441'], chip: '#1F1D1A', text: '#E7E5E4' },
  { name: 'Slate & Blue', stops: ['#1E3A5F', '#2F5D8A', '#6C9BC8'], chip: '#1A1F26', text: '#E2E8F0' },
  { name: 'Forest', stops: ['#1F4D33', '#2F7A4E', '#6BAA75'], chip: '#1A201C', text: '#E3EAE4' },
  { name: 'Ink & Bone', stops: ['#57534E', '#A8A29E', '#E7E5E4'], chip: '#1C1B1A', text: '#F5F5F4' },
  { name: 'Wine', stops: ['#4C0519', '#881337', '#C2546F'], chip: '#1F1A1C', text: '#F1E7EA' },
]

const OK = '#6BAA75'
const WARN = '#D9A441'
const HOT = '#D9534F'
const TRACK = '#2E2E2E'
const MUTED = '#8A8580'

function themeOf(i: number): Theme {
  return THEMES[((i % THEMES.length) + THEMES.length) % THEMES.length] ?? THEMES[0]!
}

/** The next theme, remembered in the store so new sessions start with it. */
async function nextTheme($: EngineInterface): Promise<Theme> {
  const i = await update($, themeIdx, n => (((n + 1) % THEMES.length) + THEMES.length) % THEMES.length)
  await $.store.set('theme', i).catch(() => undefined)
  return themeOf(i)
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

/** A 0..1 position that goes and comes back, shifted by the frame: the gradient "flows". */
function wave(i: number, n: number, shift: number): number {
  const p = (((i / Math.max(1, n)) + shift) % 1 + 1) % 1
  return p < 0.5 ? p * 2 : 2 - p * 2
}

function statusColor(pct: number): string {
  return pct >= 85 ? HOT : pct >= 60 ? WARN : OK
}

// ── Drawing ───────────────────────────────────────────────────────────────

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
  /** animation 'off': every state drawn still, no moves between them */
  still: boolean
}

async function view($: EngineInterface): Promise<View> {
  const [f, at, u, b, s, ag, pe, ti, m] = await Promise.all([
    read($, frame),
    read($, now),
    read($, usage),
    read($, breakdown),
    read($, stats),
    read($, agents),
    read($, peers),
    read($, themeIdx),
    read($, motionAtom),
  ])
  return { f, at, u, b, s, ag, pe, t: themeOf(ti), still: m === 'off' }
}

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** Text with a gradient that shifts with the frame. */
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

/** A gradient bar with 1/8-cell precision and a glint running along it. */
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

const isLive = (a: HudAgent) => a.status === 'running' || a.status === 'pending'

/** The "finished, your turn" sign: shown from the end of a turn until the next prompt. */
function DoneBadge(E: Els, v: View) {
  const { Text } = E
  if (!v.s.isReady || v.s.working) return null
  // the prompt is free, but background agents may still be at work
  const running = v.ag.filter(isLive).length
  return (
    <Text>
      <Text color={OK}>▐</Text>
      <Text backgroundColor={OK} color="#10241A" bold>
        ✔ DONE
      </Text>
      <Text color={OK}>▌</Text>
      {running > 0 ? (
        <Text color={WARN}>
          {' '}
          ready · {running} {running === 1 ? 'agent' : 'agents'} still running{'  '}
        </Text>
      ) : (
        <Text color={OK}> ready for the next task{'  '}</Text>
      )}
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

/** The pixel-art avatar, four cells tall, in the theme's colors. */
function Avatar(E: Els, v: View) {
  const [dark, mid, light] = v.t.stops
  const paint: Record<string, string> = { a: light!, b: mid!, c: dark!, k: v.t.chip, w: '#FFF6EE', s: light!, n: light!, d: '#6C9BC8' }
  return PixelArt(E, avatarPixels(v), code => paint[code])
}

/** Puts the avatar to the right of a block, when there is room for both. */
function withAvatar(E: Els, v: View, cols: number, draw: (w: number) => RenderElement) {
  const { Box } = E
  if (cols < 60) return draw(cols)
  return (
    <Box flexDirection="row" gap={AVATAR_GAP}>
      <Box flexDirection="column" flexGrow={1}>
        {draw(cols - AVATAR_W - AVATAR_GAP)}
      </Box>
      {Avatar(E, v)}
    </Box>
  )
}

/** A separator line with an animated gradient and an inset title. */
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
  if (ctx >= 85) out.push('Context almost full: /compact now, or /clear if you are switching tasks.')
  else if (ctx >= 60) out.push('Context past 60%: consider /compact when this step is done.')
  for (const l of v.u?.limits ?? []) {
    const p = pace(l, v.at)
    if (p.isOut) out.push(`The ${limitLabel(l.kind)} limit is used up: it is back in ${fmtDur(p.resetIn ?? NaN)}.`)
    else if (p.runsOutIn !== undefined)
      out.push(`At this pace the ${limitLabel(l.kind)} limit runs out in ~${fmtDur(p.runsOutIn)}: use /model sonnet for simple work.`)
  }
  const cacheBase = v.s.input + v.s.cacheRead + v.s.cacheWrite
  if (cacheBase > 50_000 && v.s.cacheRead / cacheBase < 0.5)
    out.push('Low cache hit rate: avoid editing CLAUDE.md or switching models mid-session.')
  if (v.ag.filter(a => a.status === 'running').length >= 4)
    out.push('Many agents in parallel: each one draws from the same 5h limit.')
  return out
}

// East Asian wide letters and emoji: two terminal cells each
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{3fffd}]/u

/** How many terminal cells a text takes. */
function cells(s: string): number {
  let n = 0
  for (const ch of s) n += ch === '\ufe0f' || ch === '\u200d' ? 0 : WIDE.test(ch) ? 2 : 1
  return n
}

/** Cuts a text to `n` terminal cells with an ellipsis; '' when there is no room. */
function clip(s: string, n: number): string {
  if (cells(s) <= n) return s
  if (n <= 1) return ''
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = cells(ch)
    if (used + w > n - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

function AgentLine(E: Els, a: HudAgent, v: View, i: number, $: EngineInterface, cols: number) {
  const { Text, Button } = E
  const isRunning = a.status === 'running' || a.status === 'pending'
  const isBad = a.status === 'failed' || a.status === 'killed'
  const icon = isRunning ? SPIN[(v.f + i) % SPIN.length] : a.status === 'completed' ? '✔' : isBad ? '✘' : '◦'
  const tint = v.t.stops[i % v.t.stops.length] ?? v.t.text
  const name = a.name || a.type
  const meta = ` ${a.tools}⚒${isRunning ? ` ${fmtDur(v.at - a.startedAt)}` : ''} ⤢`
  // A Button's Text children wrap rather than truncate, so the line is cut to the row here.
  let left = cols - 1 - 3 - cells(name) - cells(meta)
  const desc = a.description ? clip(` · ${a.description}`, left) : ''
  left -= cells(desc)
  const act = a.lastAction ? clip(` → ${a.lastAction}`, left) : ''
  return (
    <Button key={`agent-${a.id}`} plain label={`${name} ${a.description}`} onPress={() => void openViewer($, a.id)}>
      <Text color={isRunning ? tint : a.status === 'completed' ? OK : isBad ? HOT : MUTED}> {icon} </Text>
      <Text bold color={tint}>
        {name}
      </Text>
      <Text color={MUTED}>{meta}</Text>
      {desc ? <Text color={MUTED}>{desc}</Text> : null}
      {act ? <Text color={v.t.text}>{act}</Text> : null}
    </Button>
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
      {p.agentsRunning > 0 ? <Text color={v.t.text}> · {p.agentsRunning} {p.agentsRunning === 1 ? "agent" : "agents"}</Text> : null}
      {p.activity ? <Text color={v.t.text}> → {p.activity}</Text> : null}
      {isStale ? <Text color={MUTED}> (no signal {fmtDur(v.at - p.updatedAt)})</Text> : null}
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

/**
 * The two-line card in its frame. Below the prompt Claude Code lists running agents and
 * tasks, and every row they take comes out of this band: under 4 rows the frame goes
 * first, then the gauges, so what is left is never squashed.
 */
function compactCard(E: Els, v: View, cols: number, onToggle: () => void, maxRows = Infinity) {
  if (maxRows >= 4) return withAvatar(E, v, cols, w => compactBody(E, v, w, onToggle, 4))
  return compactBody(E, v, cols, onToggle, Math.max(1, maxRows))
}

function compactBody(E: Els, v: View, cols: number, onToggle: () => void, rows: number) {
  const { Box, Text, Button } = E
  const barW = cols >= 130 ? 12 : cols >= 100 ? 9 : cols >= 80 ? 6 : 4
  const ctxPct = v.u?.ctxPercent ?? 0
  const five = v.u?.limits.find(l => l.kind === 'five_hour')
  const week = v.u?.limits.find(l => l.kind === 'seven_day')
  const running = v.ag.filter(a => a.status === 'running' || a.status === 'pending').length
  const busyPeers = v.pe.filter(p => p.working).length
  const fiveReset = five ? pace(five, v.at).resetIn : undefined
  const model = (v.u?.model || '…').replace(/^claude-/, '')

  return (
    <Box flexDirection="column">
      {rows >= 3 ? Rule(E, cols, v, 'SPARK HUD', v.t.name) : null}
      {/* one Text per row: sibling Texts in a row Box wrap into columns once the band narrows */}
      {rows >= 2 ? (
      <Text wrap="truncate-end">
        {Gauge(E, 'CTX', ctxPct, barW, v, v.u?.ctxTokens !== undefined && cols >= 100 ? `  ${fmtTokens(v.u.ctxTokens)}/${fmtTokens(v.u.ctxWindow)}` : '')}
        {five ? <Text>{'  '}</Text> : null}
        {five ? Gauge(E, '5H', five.percentUsed, barW, v, fiveReset !== undefined && cols >= 110 ? `  ↻ ${fmtReset(fiveReset)}` : '') : null}
        {week && cols >= 85 ? <Text>{'  '}</Text> : null}
        {week && cols >= 85 ? Gauge(E, '7D', week.percentUsed, Math.max(3, barW - 3), v) : null}
      </Text>
      ) : null}
      <Box flexDirection="row" gap={2}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {DoneBadge(E, v)}
            {rows < 2 ? <Text bold color={statusColor(ctxPct)}>{`CTX ${Math.round(ctxPct)}%  `}</Text> : null}
            <Text color={v.t.stops[1]} bold>
              ⬢{' '}
            </Text>
            <Text color={v.t.text}>{model}</Text>
            <Text color={v.t.stops[2]} bold>
              {'  $ '}
            </Text>
            <Text color={v.t.text}>{fmtUsd(v.u?.costUsd).replace('$', '')}</Text>
            <Text color={running > 0 ? v.t.stops[2] : MUTED} bold>
              {'  '}
              {running > 0 ? SPIN[v.f % SPIN.length] : '⚙'}{' '}
            </Text>
            <Text color={v.t.text}>
              {running}/{v.ag.length} agents
            </Text>
            {v.pe.length > 0 ? (
              <Text>
                <Text color={busyPeers > 0 ? v.t.stops[0] : MUTED} bold>
                  {'  ◫ '}
                </Text>
                <Text color={v.t.text}>
                  {v.pe.length} win{busyPeers > 0 ? ` · ${busyPeers}▶` : ''}
                </Text>
              </Text>
            ) : null}
            {v.s.working && v.s.lastAction ? (
              <Text color={MUTED}>
                {'  → '}
                <Text color={v.t.text}>{v.s.lastAction}</Text>
              </Text>
            ) : null}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Button key="toggle" plain label="▾ more" onPress={onToggle} />
        </Box>
      </Box>
      {rows >= 4 ? Rule(E, cols, v, `${v.s.turns} turns · ${fmtDur(v.at - v.s.startedAt)}`, '') : null}
    </Box>
  )
}

function expandedView(E: Els, v: View, cols: number, maxRows: number, $: EngineInterface, onToggle: () => void) {
  const { Box, Text, Button } = E
  const bigW = Math.max(10, Math.min(32, cols - 48))
  const ctxPct = v.u?.ctxPercent ?? 0
  const used = (v.b?.categories ?? []).filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const catMax = Math.max(1, ...used.map(c => c.tokens))
  const cacheBase = v.s.input + v.s.cacheRead + v.s.cacheWrite
  const cacheHit = cacheBase > 0 ? Math.round((v.s.cacheRead / cacheBase) * 100) : undefined
  const running = v.ag.filter(a => a.status === 'running' || a.status === 'pending')
  const limits = v.u?.limits ?? []
  const advice = tips(v)

  // Fit the band's rows (fullscreen gives it half the terminal): the 4-row avatar block and
  // the closing rule always show; sections get the rest by priority, agents first.
  let room = Math.max(0, maxRows - 5)
  const grant = (header: number, items: number): number => {
    if (room < header + Math.min(1, items)) return -1
    const n = Math.min(items, room - header)
    room -= header + n
    return n
  }
  const agentRows = grant(1, Math.max(1, Math.min(8, v.ag.length)) + (v.ag.length > 8 ? 1 : 0))
  const limitRows = grant(1, Math.max(1, limits.length * 2))
  const sessionRows = grant(1, v.s.working && v.s.lastAction ? 2 : 1)
  const catRows = grant(0, Math.min(6, used.length))
  const peerRows = grant(1, Math.max(1, Math.min(6, v.pe.length)))
  const tipRows = advice.length > 0 ? grant(1, advice.length) : -1
  const agentCap = v.ag.length > agentRows ? Math.max(0, agentRows - 1) : agentRows
  const shownAgents = [...v.ag].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')).slice(0, Math.max(0, agentCap))
  const withPace = limitRows >= limits.length * 2

  return (
    <Box flexDirection="column">
      {withAvatar(E, v, cols, w => (
        <Box flexDirection="column">
          {Rule(E, w, v, 'SPARK HUD', v.t.name)}
          <Box flexDirection="row" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                {DoneBadge(E, v)}
                <Text color={v.t.text}>{v.u?.model || '…'}</Text>
                <Text color={MUTED}>
                  {' '}
                  · session {fmtDur(v.at - v.s.startedAt)} · {v.s.turns} turns
                </Text>
              </Text>
            </Box>
            <Box flexDirection="row" gap={2} flexShrink={0}>
              <Button key="theme" plain label="◐ theme" onPress={() => void nextTheme($)} />
              <Button key="panel" plain label="◫ panel" onPress={() => void $.ui.open({ id: PANE, title: 'Spark HUD · agents' })} />
              <Button key="toggle" plain label="▴ less" onPress={onToggle} />
            </Box>
          </Box>
          {Header(E, 'CONTEXT WINDOW', v)}
          <Text wrap="truncate-end">
            <Text>{'  '}</Text>
            {GradBar(E, ctxPct, Math.max(8, Math.min(bigW, w - 48)), v, v.s.working)}
            <Text bold color={statusColor(ctxPct)}>
              {' '}
              {ctxPct}%
            </Text>
            <Text color={v.t.text}>
              {'  '}
              {fmtTokens(v.u?.ctxTokens)} / {fmtTokens(v.u?.ctxWindow)}
            </Text>
            <Text color={MUTED}>
              {v.b?.autoCompactAt ? `  · autocompact at ${fmtTokens(v.b.autoCompactAt)}` : v.b && !v.b.isAutoCompact ? '  · autocompact OFF' : ''}
            </Text>
          </Text>
        </Box>
      ))}
      {used.slice(0, Math.max(0, catRows)).map((c, i) => {
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

      {limitRows >= 0 ? Header(E, 'PLAN LIMITS', v) : null}
      {limitRows >= 0 && limits.length === 0 ? <Text color={MUTED} wrap="truncate-end">  None yet: they arrive with the next reply (API-key sessions have none).</Text> : null}
      {limits.slice(0, Math.max(0, limitRows)).map(l => {
        const p = pace(l, v.at)
        const diff = (p.expected !== undefined || p.isOut) && withPace ? l.percentUsed - (p.expected ?? 100) : undefined
        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text>{'  '}</Text>
              {Chip(E, clip(limitLabel(l.kind).toUpperCase(), 9).padEnd(9, ' '), v)}
              <Text> </Text>
              {GradBar(E, l.percentUsed, bigW, v, v.s.working)}
              <Text bold color={statusColor(l.percentUsed)}>
                {' '}
                {Math.round(l.percentUsed)}%
              </Text>
              {p.resetIn !== undefined ? <Text color={MUTED}>  ↻ {fmtReset(p.resetIn)}</Text> : null}
            </Text>
            {diff !== undefined ? (
              <Text wrap="truncate-end">
                <Text color={MUTED}>{'              pace '}</Text>
                {p.isOut ? (
                  <Text color={HOT} bold>
                    ■ limit reached, back in {fmtDur(p.resetIn ?? NaN)}
                  </Text>
                ) : p.runsOutIn !== undefined ? (
                  <Text color={HOT} bold>
                    ▲ runs out in ~{fmtDur(p.runsOutIn)}, before the reset
                  </Text>
                ) : diff > 5 ? (
                  <Text color={WARN}>▲ {Math.round(diff)}% ahead of the expected pace</Text>
                ) : (
                  <Text color={OK}>▼ comfortable ({Math.round(-diff)}% under the linear pace)</Text>
                )}
              </Text>
            ) : null}
          </Box>
        )
      })}

      {sessionRows >= 0 ? Header(E, 'SESSION', v) : null}
      {sessionRows >= 1 ? (
      <Text wrap="truncate-end">
        <Text>{'  '}</Text>
        {Chip(E, `$ ${fmtUsd(v.u?.costUsd).replace('$', '')}`, v)}
        <Text>{'  '}</Text>
        {Chip(E, `⚒ ${v.s.toolCalls}`, v)}
        <Text>{'  '}</Text>
        {Chip(E, `⏱ ${v.s.lastTurnMs !== undefined ? `${fmtDur(v.s.lastTurnMs)}/${v.s.lastTurnTools}⚒` : '—'}`, v)}
        <Text>{'  '}</Text>
        {Chip(E, `cache ${cacheHit === undefined ? '—' : `${cacheHit}%`}`, v, cacheHit === undefined ? v.t.text : statusColor(100 - cacheHit))}
        <Text>{'  '}</Text>
        {Chip(E, `out ${fmtTokens(v.s.output)}`, v)}
      </Text>
      ) : null}
      {sessionRows >= 2 ? (
        <Text wrap="truncate-end">
          <Text color={MUTED}>  now </Text>
          <Text color={v.t.text}>{v.s.lastAction}</Text>
          <Text color={MUTED}> ({fmtDur(v.at - v.s.turnStartedAt)})</Text>
        </Text>
      ) : null}

      {agentRows >= 0 ? Header(E, 'AGENTS', v, `${running.length} active / ${v.ag.length}`) : null}
      {agentRows >= 0 && v.ag.length === 0 ? <Text color={MUTED} wrap="truncate-end">  None in this session.</Text> : null}
      {shownAgents.map((a, i) => AgentLine(E, a, v, i, $, cols))}
      {agentRows >= 1 && v.ag.length > shownAgents.length ? <Text color={MUTED} wrap="truncate-end">  … {v.ag.length - shownAgents.length} more in ◫ panel</Text> : null}

      {peerRows >= 0 ? Header(E, 'OTHER WINDOWS', v, `${v.pe.length}`) : null}
      {peerRows >= 0 && v.pe.length === 0 ? <Text color={MUTED} wrap="truncate-end">  No other session running spark-hud.</Text> : null}
      {v.pe.slice(0, Math.max(0, peerRows)).map((p, i) => PeerLine(E, p, v, i))}

      {tipRows >= 0 ? Header(E, 'TIPS', v) : null}
      {advice.slice(0, Math.max(0, tipRows)).map(t => (
        <Text wrap="truncate-end" color={WARN}>
          {'  ✦ '}
          {t}
        </Text>
      ))}
      {Rule(E, cols, v, `theme ${v.t.name} · /hud-theme to change`, '')}
    </Box>
  )
}

// ── Agent viewer ─────────────────────────────────────────────────────────

function firstLine(text: string, max = 90): string {
  const line = text.split(/\r?\n/).find(l => l.trim() !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

async function refreshViewer($: EngineInterface, agentId: string) {
  const messages = await $.session.messages({ agentId })
  if (!Array.isArray(messages)) return
  const rows: HudViewRow[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.text.trim() && rows.length === 0) rows.push({ kind: 'task', text: m.text.trim() })
      continue
    }
    if (m.text.trim()) rows.push({ kind: 'text', text: m.text.trim() })
    for (const use of m.toolUses) {
      const lines = use.text === undefined ? 0 : use.text.split(/\r?\n/).length
      rows.push({
        kind: 'tool',
        text: describeTool(use.tool, use.input),
        ...(use.text === undefined
          ? { isPending: true }
          : { detail: use.isError ? firstLine(use.text) : `${firstLine(use.text, 70)}${lines > 1 ? `  (+${lines - 1} lines)` : ''}` }),
        ...(use.isError ? { isError: true } : {}),
      })
    }
  }
  // keep the task, which opens the transcript, and the latest steps
  await update($, viewerRows, () => (rows.length > 300 ? [rows[0]!, ...rows.slice(-299)] : rows))
}

async function openViewer($: EngineInterface, agentId: string) {
  await update($, viewerAgent, () => agentId)
  await update($, viewerRows, () => [])
  const list = await read($, agents)
  const a = list.find(x => x.id === agentId)
  await $.ui.open({ id: VIEWER, title: `Agent · ${a ? a.name || a.type : agentId}`, focus: true, closeOnEscape: true, rows: 22 })
  await refreshViewer($, agentId).catch(() => undefined)
}

function ViewerBody(E: Els, v: View, cols: number, rowsAvail: number, $: EngineInterface, agentId: string | null, rows: HudViewRow[]) {
  const { Box, Text, Button } = E
  const a = v.ag.find(x => x.id === agentId)
  if (!a) {
    return (
      <Box flexDirection="column">
        {Rule(E, cols, v, 'AGENT VIEWER', v.t.name)}
        <Text color={MUTED} wrap="truncate-end">
          {v.ag.length === 0 ? '  No agents yet in this session: they show up here once Claude starts one.' : '  Pick an agent:'}
        </Text>
        {v.ag.map((x, i) => AgentLine(E, x, v, i, $, cols))}
      </Box>
    )
  }
  const isRunning = a.status === 'running' || a.status === 'pending'
  const isBad = a.status === 'failed' || a.status === 'killed'
  const idx = v.ag.findIndex(x => x.id === a.id)
  const prev = v.ag[(idx - 1 + v.ag.length) % v.ag.length]
  const nextA = v.ag[(idx + 1) % v.ag.length]
  const ctxPct = a.ctxTokens !== undefined && v.u?.ctxWindow ? Math.round((a.ctxTokens / v.u.ctxWindow) * 100) : undefined
  const task = rows.find(r => r.kind === 'task')
  const body = rows.filter(r => r.kind !== 'task')
  const room = Math.max(4, rowsAvail - 7)
  const shown = body.slice(-room)
  const tint = v.t.stops[idx % v.t.stops.length] ?? v.t.text

  return (
    <Box flexDirection="column">
      {Rule(E, cols, v, `AGENT · ${a.name || a.type}`, a.status)}
      <Box flexDirection="row" gap={2}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={isRunning ? tint : a.status === 'completed' ? OK : isBad ? HOT : MUTED} bold>
              {isRunning ? SPIN[v.f % SPIN.length] : a.status === 'completed' ? '✔' : isBad ? '✘' : '◦'}{' '}
            </Text>
            <Text bold color={tint}>{a.type}</Text>
            {a.description ? <Text color={MUTED}> · {a.description}</Text> : null}
          </Text>
        </Box>
        {/* the pane's frame draws its own ✕, and Esc closes it */}
        {v.ag.length > 1 && prev && nextA ? (
          <Box flexDirection="row" gap={2} flexShrink={0}>
            <Button key="prev" plain label="◀" onPress={() => void openViewer($, prev.id)} />
            <Button key="next" plain label="▶" onPress={() => void openViewer($, nextA.id)} />
          </Box>
        ) : null}
      </Box>
      <Text wrap="truncate-end">
        {Chip(E, `⚒ ${a.tools}`, v)}
        <Text> </Text>
        {Chip(E, `⏱ ${fmtDur((isRunning ? v.at : a.updatedAt) - a.startedAt)}`, v)}
        <Text> </Text>
        {Chip(E, `ctx ${fmtTokens(a.ctxTokens)}${ctxPct !== undefined ? ` · ${ctxPct}%` : ''}`, v, ctxPct === undefined ? v.t.text : statusColor(ctxPct))}
        {a.model ? (
          <Text>
            <Text> </Text>
            {Chip(E, a.model.replace(/^claude-/, ''), v)}
          </Text>
        ) : null}
      </Text>
      {task ? (
        <Text wrap="truncate-end">
          <Text color={v.t.stops[1]} bold>{'  task '}</Text>
          <Text color={v.t.text}>{firstLine(task.text, 400)}</Text>
        </Text>
      ) : null}
      {body.length > shown.length ? <Text color={MUTED} wrap="truncate-end">  … {body.length - shown.length} earlier steps</Text> : null}
      {shown.length === 0 ? <Text color={MUTED} wrap="truncate-end">  {isRunning ? 'Waiting for the first step…' : 'No transcript available for this agent.'}</Text> : null}
      {shown.map((r, i) =>
        r.kind === 'text' ? (
          <Text wrap="truncate-end">
            <Text color={tint}>{'  ✻ '}</Text>
            <Text color={v.t.text}>{firstLine(r.text, 400)}</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <Text color={r.isError ? HOT : r.isPending ? tint : OK}>
              {'  '}
              {r.isPending ? SPIN[(v.f + i) % SPIN.length] : r.isError ? '✘' : '⚒'}{' '}
            </Text>
            <Text color={v.t.text} bold>{r.text}</Text>
            {r.detail ? <Text color={r.isError ? HOT : MUTED}>  {r.detail}</Text> : null}
          </Text>
        ),
      )}
      {Rule(E, cols, v, isRunning ? 'live · updates every second' : 'finished', '')}
    </Box>
  )
}

async function toggle($: EngineInterface, columns?: number) {
  const open = await update($, isExpanded, v => !v)
  if (open) await refreshBreakdown($, columns ?? 100).catch(() => undefined)
}

// ── Registration ─────────────────────────────────────────────────────────────

/** What the tick loop and the hooks share; one per loaded module. */
type Runtime = {
  motion: Motion
  isSharing: boolean
  link: PeerLink
  last: { agents: number; viewer: number; peers: number; usage: number }
  // highest threshold already announced, per limit kind and for the context ('ctx')
  warned: Map<string, number>
  timer?: { cancel: () => void }
  isLooping: boolean
}

async function tick($: EngineInterface, rt: Runtime): Promise<number> {
  const { last } = rt
  const at = await $.clock.now()
  const [s, ag, watching] = await Promise.all([read($, stats), read($, agents), read($, viewerAgent)])
  const hasRunning = ag.some(isLive)
  const isBusy = s.working || hasRunning
  const isAnimating = isBusy || at < s.celebrateUntil
  if (rt.motion !== 'off') await update($, frame, f => (f + 1) % 10_000)
  await update($, now, () => at)
  // the agent viewer, only while its pane is open: every second while its agent runs
  if (watching) {
    const target = ag.find(a => a.id === watching)
    const every = !target || isLive(target) ? 1000 : 5000
    if (at - last.viewer >= every) {
      last.viewer = at
      await refreshViewer($, watching).catch(() => undefined)
    }
  }
  if (isBusy && at - last.agents >= 1000) {
    last.agents = at
    await refreshAgents($, at).catch(() => undefined)
  }
  if (rt.isSharing && at - last.peers >= 5000) {
    last.peers = at
    await heartbeat($, rt.link).catch(() => undefined)
    await refreshPeers($, rt.link, at).catch(() => undefined)
  }
  // at rest: keep reset countdowns honest
  if (!isBusy && at - last.usage >= 30_000) {
    last.usage = at
    await refreshUsage($).catch(() => undefined)
  }
  return tickDelay(rt.motion, isAnimating)
}

/** (Re)starts the tick loop: on session start, and when work begins during a slow rest. */
function kick($: EngineInterface, rt: Runtime, ms = 0) {
  rt.timer?.cancel()
  rt.timer = $.clock.after(ms, () => {
    if (rt.isLooping) return
    rt.isLooping = true
    void tick($, rt)
      .catch(() => tickDelay(rt.motion, false))
      .then(delay => {
        rt.isLooping = false
        kick($, rt, delay)
      })
  })
}

/** Toasts once when a reading crosses a threshold upward; it re-arms once the reading falls back. */
function warnOnce($: EngineInterface, rt: Runtime, key: string, pct: number, thresholds: number[], text: (level: number) => string) {
  const level = thresholds.filter(t => pct >= t).pop() ?? 0
  if (level > (rt.warned.get(key) ?? 0)) $.ui.toast(text(level))
  rt.warned.set(key, level)
}

export const register: Register = (on, options) => {
  const rt: Runtime = {
    motion: options.animation === 'calm' || options.animation === 'off' ? options.animation : 'full',
    isSharing: options.shareWithOtherWindows !== false,
    link: { id: '', slot: '', lastText: '', lastWriteAt: 0 },
    last: { agents: 0, viewer: 0, peers: 0, usage: 0 },
    warned: new Map(),
    isLooping: false,
  }
  const { link } = rt

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    link.id = await $.session.id()
    const u = await $.session.usage()
    const at = await $.clock.now()
    await update($, stats, s => ({ ...s, startedAt: u.startedAt }))
    await update($, motionAtom, () => rt.motion)
    const saved = await $.store.get('theme').catch(() => undefined)
    if (typeof saved === 'number' && Number.isInteger(saved)) await update($, themeIdx, () => saved)
    await update($, now, () => at)
    await refreshUsage($).catch(() => undefined)

    await $.command.register({ name: 'hud', description: 'Spark HUD: expand / collapse the HUD above the prompt' })
    await $.command.register({ name: 'hud-theme', description: 'Spark HUD: switch to the next color theme' })
    await $.command.register({ name: 'hud-agents', description: 'Spark HUD: open the agent viewer (live transcript of a subagent)' })
    await $.command.register({ name: 'hud-panel', description: 'Spark HUD: open the side panel with agents and windows' })

    if (rt.isSharing) {
      await claimSlot($, link, at).catch(() => undefined)
      await heartbeat($, link).catch(() => undefined)
    }
    kick($, rt)
    return result
  })

  on('session.end', async ($, e, next) => {
    rt.timer?.cancel()
    if (rt.isSharing && link.slot) await heartbeat($, link, true).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    await toggle($)
    return { text: (await read($, isExpanded)) ? 'Spark HUD expanded.' : 'Spark HUD collapsed.' }
  })

  on('command.run', { command: 'hud-theme' }, async $ => {
    const t = await nextTheme($)
    return { text: `Theme: ${t.name}` }
  })

  on('command.run', { command: 'hud-agents' }, async $ => {
    const list = await read($, agents)
    const pick = list.find(a => a.status === 'running') ?? list[list.length - 1]
    if (!pick) {
      await $.ui.open({ id: VIEWER, title: 'Agent viewer', focus: true, closeOnEscape: true, rows: 10 })
      return { text: 'No agents yet in this session.' }
    }
    await openViewer($, pick.id)
    return { text: `Viewing agent ${pick.name || pick.type}.` }
  })

  on('command.run', { command: 'hud-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Spark HUD · agents' })
    return { text: opened.isPlaced ? 'Spark HUD panel opened.' : 'Panel ready: it shows once the terminal is wider (or in fullscreen mode).' }
  })

  // a closed viewer stops reading its agent's transcript
  on('ui.close', async ($, e, next) => {
    if (e.id === VIEWER) {
      await update($, viewerAgent, () => null)
      await update($, viewerRows, () => [])
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, stats, s => ({ ...s, working: true, turnStartedAt: at, turnTools: 0, lastAction: 'thinking…', lastTool: '', isReady: false, doneAt: 0 }))
    await update($, now, () => at)
    // the wake-up plays now, not at the next resting tick
    kick($, rt)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const tool = String(e.tool)
    // shown on this screen only; other windows get toolLabel(tool) alone
    const action = describeTool(tool, e as unknown as Record<string, unknown>)
    if (e.agentId) {
      const id = e.agentId
      // An id the list does not name yet is a new agent, or one of the engine's own forks
      // (compaction, memory, classifiers), which never shows in the list and stays out of the HUD.
      if (!(await read($, agents)).some(a => a.id === id)) await refreshAgents($, at).catch(() => undefined)
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, lastAction: action, tools: a.tools + 1, updatedAt: at } : a)))
    } else {
      await update($, stats, s => ({ ...s, lastAction: action, lastTool: toolLabel(tool), turnTools: s.turnTools + 1, toolCalls: s.toolCalls + 1 }))
    }
    const result = await next(e)
    if (e.tool === 'Agent') await refreshAgents($, await $.clock.now()).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId
    const u = result.usage
    if (id && u) {
      const ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, ctxTokens: ctx, model: u.model } : a))).catch(() => undefined)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, lastAction: 'done', updatedAt: at } : a)))
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
      lastAction: e.isAborted ? 'interrupted' : 'done',
      lastTool: '',
      isReady: !e.isAborted,
      input: s.input + (u?.input_tokens ?? 0),
      output: s.output + (u?.output_tokens ?? 0),
      cacheRead: s.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: s.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      doneAt: e.isAborted ? 0 : at,
      abortAt: e.isAborted ? at : s.abortAt,
      celebrateUntil: at + (e.isAborted ? SHAKE_MS : DONE_MS),
    }))
    await update($, now, () => at)
    await refreshUsage($).catch(() => undefined)
    await refreshAgents($, at).catch(() => undefined)
    if (await read($, isExpanded)) await refreshBreakdown($, 100).catch(() => undefined)
    if (rt.isSharing && link.slot) await heartbeat($, link).catch(() => undefined)
    kick($, rt)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($).catch(() => undefined)
    for (const l of e.rateLimits) {
      const label = limitLabel(l.kind)
      warnOnce($, rt, `limit:${l.kind}`, l.percentUsed, [75, 90], n => `✻ ${label} limit past ${n}%`)
    }
    const ctx = e.context.percent
    if (ctx !== undefined) warnOnce($, rt, 'ctx', ctx, [85], () => `✻ Context at ${ctx}%: a good moment to /compact`)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const E = $.ui.resolve(e)
    const v = await view($)
    const cols = e.props.bodyColumns
    const columns = e.viewport?.columns
    const onToggle = () => void toggle($, columns)
    const rows = e.props.maxRows
    if (rows < 1) return next(e)
    return (await read($, isExpanded)) && rows >= 8 ? expandedView(E, v, cols, rows, $, onToggle) : compactCard(E, v, cols, onToggle, rows)
  })

  on('ui.render', { component: 'Pane', requestId: VIEWER }, async ($, e) => {
    const E = $.ui.resolve(e)
    const v = await view($)
    const [id, rows] = await Promise.all([read($, viewerAgent), read($, viewerRows)])
    return ViewerBody(E, v, e.props.bodyColumns, e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24, $, id, rows)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e)
    const { Box, Text } = E
    const v = await view($)
    const cols = e.props.bodyColumns
    return (
      <Box flexDirection="column">
        {compactCard(E, v, cols, () => void toggle($))}
        <Text bold color="claude" wrap="truncate-end">
          Agents in this session <Text dimColor>({v.ag.length})</Text>
        </Text>
        {v.ag.length === 0 ? <Text dimColor wrap="truncate-end">  None yet.</Text> : null}
        {v.ag.map((a, i) => AgentLine(E, a, v, i, $, cols))}
        <Text bold color="claude" wrap="truncate-end">
          Other windows <Text dimColor>({v.pe.length})</Text>
        </Text>
        {v.pe.length === 0 ? (
          <Text dimColor wrap="truncate-end">{rt.isSharing ? '  Open another Claude Code session: it shows up here on its own.' : '  Sharing between windows is off in this mod’s settings.'}</Text>
        ) : null}
        {v.pe.map((p, i) => PeerLine(E, p, v, i))}
      </Box>
    )
  })
}
