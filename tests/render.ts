// A plain-text approximation of how a terminal lays a drawn tree out, for previews and
// layout checks: Box rows and columns, gap, width, flexGrow/flexShrink, Text truncation,
// and two-cell emoji and CJK. It is not Ink: it flags what would break, it does not paint.

/** true prints every preview the gallery and edge tests draw. */
export const SHOW = false
const out = (globalThis as unknown as { console: { log: (s: string) => void } }).console
export const show = (s: string) => (SHOW ? out.log(s) : undefined)

type El = { type: string; props?: Record<string, unknown>; children?: unknown[] }

export type Rendered = { lines: string[]; problems: string[] }

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfe0f || cp === 0x200d) continue
    w += WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
  }
  return w
}

function cut(s: string, n: number): string {
  if (cellWidth(s) <= n) return s
  let out = ''
  for (const ch of s) {
    if (cellWidth(out + ch) > n - 1) break
    out += ch
  }
  return n >= 1 ? `${out}…` : ''
}

function wrapHard(s: string, n: number): string[] {
  const out: string[] = []
  let line = ''
  for (const ch of s) {
    if (cellWidth(line + ch) > n) {
      out.push(line)
      line = ''
    }
    line += ch
  }
  out.push(line)
  return out
}

const isEl = (x: unknown): x is El => typeof x === 'object' && x !== null && 'type' in x

export function flat(x: unknown): string {
  if (x === null || x === undefined || typeof x === 'boolean') return ''
  if (typeof x === 'string' || typeof x === 'number') return String(x)
  if (Array.isArray(x)) return x.map(flat).join('')
  if (isEl(x)) {
    if (x.type === 'Button' && !(x.children ?? []).some(c => flat(c) !== '')) return String(x.props?.label ?? '')
    return (x.children ?? []).map(flat).join('')
  }
  return ''
}

const pad = (s: string, n: number) => (Number.isFinite(n) ? s + ' '.repeat(Math.max(0, n - cellWidth(s))) : s)

function lay(x: unknown, w: number, problems: string[], path: string): string[] {
  if (!isEl(x)) {
    const s = flat(x)
    return s ? [s] : []
  }
  const p = x.props ?? {}
  if (x.type === 'Text' || x.type === 'Button') {
    const text = flat(x)
    const rows = text.split('\n')
    if (p.wrap === 'truncate-end' || p.wrap === 'truncate') return rows.map(r => cut(r, w))
    const out = rows.flatMap(r => wrapHard(r, w))
    if (out.length > rows.length && Number.isFinite(w)) problems.push(`${path}: ${x.type} wraps at ${w} cols: "${cut(text, 60)}"`)
    return out
  }
  const kids = (x.children ?? []).filter(c => isEl(c) || flat(c) !== '')
  const own = typeof p.width === 'number' ? Math.min(p.width, w) : w
  if ((p.flexDirection ?? 'row') === 'column') {
    return kids.flatMap((k, i) => lay(k, own, problems, `${path}/${i}`))
  }
  const gap = typeof p.gap === 'number' ? p.gap : 0
  const avail = own - gap * Math.max(0, kids.length - 1)
  const props = kids.map(k => (isEl(k) ? (k.props ?? {}) : {}))
  const natural = kids.map((k, i) =>
    typeof props[i]!.width === 'number' ? (props[i]!.width as number) : Math.max(0, ...lay(k, Infinity, [], '').map(cellWidth)),
  )
  const widths = [...natural]
  let over = widths.reduce((a, b) => a + b, 0) - avail
  // shrink the shrinkable ones (no fixed width, flexShrink not 0), widest first
  while (over > 0) {
    const i = widths
      .map((wd, j) => ({ wd, j }))
      .filter(({ j }) => props[j]!.flexShrink !== 0 && typeof props[j]!.width !== 'number' && widths[j]! > 0)
      .sort((a, b) => b.wd - a.wd)[0]?.j
    if (i === undefined) {
      problems.push(`${path}: row needs ${avail + over} cols, has ${avail}`)
      break
    }
    const take = Math.min(over, widths[i]!)
    widths[i]! -= take
    over -= take
  }
  if (over < 0 && Number.isFinite(over)) {
    const g = props.findIndex(q => typeof q.flexGrow === 'number' && (q.flexGrow as number) > 0)
    if (g >= 0) widths[g]! += -over
  }
  const cols = kids.map((k, i) => lay(k, widths[i]!, problems, `${path}/${i}`))
  const h = Math.max(0, ...cols.map(c => c.length))
  const out: string[] = []
  for (let r = 0; r < h; r += 1) out.push(cols.map((c, i) => pad(c[r] ?? '', widths[i]!)).join(' '.repeat(gap)).trimEnd())
  return out
}

export function render(tree: unknown, cols: number): Rendered {
  const problems: string[] = []
  const lines = lay(tree, cols, problems, 'root')
  lines.forEach((l, i) => {
    if (cellWidth(l) > cols) problems.push(`line ${i + 1} is ${cellWidth(l)} cols, band is ${cols}: "${l}"`)
  })
  return { lines, problems }
}

export function frame(title: string, r: Rendered, cols: number): string {
  const bar = '─'.repeat(cols)
  return [`┌ ${title}`, `┌${bar}┐`, ...r.lines.map(l => `│${pad(l, cols)}│`), `└${bar}┘`, ...r.problems.map(p => `  ! ${p}`)].join('\n')
}
