import { expect, mock, test } from 'claude-code/testing'

import { frame, render, show } from './render'

// Every view, in every state that matters, at every width a real terminal gives the band.
// Each one is laid out as text (tests/render.ts) and must fit: no line wider than the band,
// no row that wraps, no more rows than the band allows. SHOW in render.ts prints the previews.

const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

type Agent = { id: string; description: string; type: string; status: string; name?: string }
type Scenario = {
  name: string
  usage: unknown
  agents?: Agent[]
  peers?: Record<string, unknown>[]
  working?: string // a Bash command run in a turn left open
  done?: boolean // a turn that finished
}

const LONG = 'migrate every legacy authentication call site across the monorepo to the new session API and update tests'

const SCENARIOS: Scenario[] = [
  { name: 'fresh session, nothing measured', usage: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } },
  {
    name: 'API key: no plan limits',
    usage: { startedAt: 0, context: { tokens: 31_000, window: 200_000, percent: 16 }, rateLimits: [], cost: { usd: 0.42 } },
    done: true,
  },
  {
    name: 'Pro, a calm day',
    usage: {
      startedAt: 0,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: iso(2 * H) },
        { kind: 'seven_day', percentUsed: 12, resetsAt: iso(5 * 24 * H) },
      ],
      cost: { usd: 1.23 },
    },
  },
  {
    name: 'Max, everything red, working',
    usage: {
      startedAt: 0,
      context: { tokens: 990_000, window: 1_000_000, percent: 99 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 97, resetsAt: iso(4 * H) },
        { kind: 'seven_day', percentUsed: 88, resetsAt: iso(H) },
        { kind: 'seven_day_opus', percentUsed: 100, resetsAt: iso(30 * H) },
        { kind: 'seven_day_sonnet', percentUsed: 61 },
        { kind: 'some_future_kind', percentUsed: 140, resetsAt: 'not a date' },
      ],
      cost: { usd: 1234.5 },
    },
    working: `cd /very/long/path/to/project && ${LONG}`,
  },
  {
    name: 'a dozen agents, long and wide text',
    usage: { startedAt: 0, context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [{ kind: 'five_hour', percentUsed: 64 }] },
    agents: [
      { id: 'a1', type: 'Explore', status: 'running', description: LONG },
      { id: 'a2', type: 'general-purpose', status: 'running', description: '日本語のリポジトリを調査する長い説明テキスト', name: '調査員' },
      { id: 'a3', type: 'Plan', status: 'completed', description: 'plan the refactor' },
      { id: 'a4', type: 'Code Reviewer', status: 'failed', description: 'review 🔥 hot paths 🚀' },
      { id: 'a5', type: 'Explore', status: 'killed', description: '' },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, type: 'Explore', status: i % 2 ? 'pending' : 'running', description: `shard ${i}` })),
    ],
    working: 'npm test',
  },
  {
    name: 'other windows, hostile and wide names',
    usage: { startedAt: 0, context: { tokens: 5_000, window: 200_000, percent: 2 }, rateLimits: [] },
    peers: [
      { id: 'p1', project: 'landing-page', model: 'claude-sonnet-5-5', ctxPercent: 31, working: true, activity: 'Edit', agentsRunning: 2 },
      { id: 'p2', project: 'プロジェクト名がとても長いリポジトリ', model: 'claude-opus-5-5', ctxPercent: 78, working: false, activity: '', agentsRunning: 0 },
      { id: 'p3', project: '\u001b[31mred\u001b[0m‮evil', model: 'x'.repeat(500), ctxPercent: -40, working: true, activity: 'MCP', agentsRunning: 1e9 },
      { id: 'p4', project: '🚀 rocket app', model: 'claude-haiku-5-5', working: false, activity: '', agentsRunning: 0 },
    ],
    done: true,
  },
]

const WIDTHS = [32, 48, 59, 60, 72, 80, 100, 120, 160, 220]

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

async function setup($: Parameters<Body>[0], on: Parameters<Body>[1], s: Scenario) {
  const clock = mock.clock(on)
  const files = new Map((s.peers ?? []).map(p => [`${p.id}.json`, JSON.stringify({ ...p, updatedAt: 0 })]))
  mock.env(on, { HOME: '/home/u' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [...files].map(([name, text]) => ({ name, kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path.split(/[\\/]/).pop() ?? '') ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.usage', () => ({ value: s.usage as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: (s.agents ?? []) as never }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  if (s.working || s.done) await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  if (s.working) await $.tool.call({ tool: 'Bash', command: s.working })
  for (const a of s.agents ?? []) await $.tool.call({ tool: 'Read', file_path: `/src/${a.id}.ts`, agentId: a.id })
  if (s.done) await $.turn.complete({ answer: '', durationMs: 42_000, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(s.working ? 6_000 : 10_000)
}

const band = (cols: number, maxRows: number) => ({
  plugin: 'spark-hud',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: cols, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
})

for (const s of SCENARIOS) {
  test(`views fit: ${s.name}`, async ($, on) => {
    await setup($, on, s)
    const problems: string[] = []
    const out: string[] = []
    for (const expanded of [false, true]) {
      for (const cols of WIDTHS) {
        // fullscreen gives the band about half the terminal; a short one still has to fit
        for (const maxRows of expanded ? [4, 6, 8, 14, 40] : [1, 2, 3, 4, 40]) {
          const ui = await $.ui.mount(band(cols, maxRows))
          if (expanded && !(await ui.find({ key: 'theme' }))) await ui.press({ key: 'toggle' })
          const r = render(await ui.drawn(), cols)
          const label = `${s.name} · ${expanded ? 'expanded' : 'compact'} · ${cols} cols · ${maxRows} rows`
          if (r.lines.length > maxRows) r.problems.push(`${r.lines.length} rows, band allows ${maxRows}`)
          problems.push(...r.problems.map(p => `${label}: ${p}`))
          out.push(frame(label, r, cols))
          await ui.unmount()
        }
      }
    }
    show(`\n${out.join('\n\n')}\n`)
    expect(problems).toEqual([])
  })
}

test('views fit: side panel and agent viewer', async ($, on) => {
  const s = SCENARIOS[4]!
  await setup($, on, s)
  const problems: string[] = []
  const out: string[] = []
  for (const cols of [30, 44, 60, 90]) {
    for (const id of ['spark-hud-panel', 'spark-hud-agent']) {
      const ui = await $.ui.mount({
        plugin: 'spark-hud',
        surface: 'terminal',
        component: 'Pane',
        requestId: id,
        props: { title: 'x', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      const r = render(await ui.drawn(), cols)
      problems.push(...r.problems.map(p => `${id} ${cols}: ${p}`))
      out.push(frame(`${id} · ${cols} cols`, r, cols))
      await ui.unmount()
    }
  }
  show(`\n${out.join('\n\n')}\n`)
  expect(problems).toEqual([])
})
