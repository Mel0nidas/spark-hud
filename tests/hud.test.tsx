import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const LINE_FILE = '/home/me/.claude/spark-hud/line/s1.ansi'
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

// Stands for the engine beneath the plugin. Returns the status line text the mod
// last wrote, its ANSI styling removed.
function engine(on: On) {
  const clock = mock.clock(on)
  const reading = {
    startedAt: 0,
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(clock.now() + 2 * 3600_000 + 17 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 12 },
    ],
    cost: { usd: 1.23 },
  }
  const written = new Map<string, string>()
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/home/me/project' }))
  on('session.usage', () => ({ value: reading }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('store.get', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { clock, line: () => plain(written.get(LINE_FILE) ?? '(none)') }
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/home/me/project', surface: 'terminal', isInteractive: true })

test('ultracompact is the default: the line goes to the status line, nothing above the prompt', async ($, on) => {
  const { clock, line } = engine(on)
  await start($)
  await clock.advance(1000)

  expect(line()).toMatch(/^CTX .*42%.*5H .*23%.*7D .*12%.*⬢ opus-5-5.*\$ 1\.23.*⚙ 0\/0 agents.*0 turns/)
  // at 120 columns the room left adds the reset time and bars
  expect(line()).toMatch(/5H \S+ 23% ↻ 2h 1[67]m/)
  expect([...line()].length).toBeLessThanOrEqual(116)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'spark-hud', surface, ...BAND })
    expect(await band.find({ text: /engine band/ })).toBeDefined()
    expect(await band.find({ text: /42%/ })).toBeUndefined()
    await band.unmount()
  }
})

test('the line keeps context, then 5h, then 7d as the terminal narrows', async ($, on) => {
  const { clock, line } = engine(on)
  await start($)
  const at = async (columns: number) => {
    const band = await $.ui.mount({ plugin: 'spark-hud', surface: 'terminal', ...BAND, viewport: { columns, rows: 40 } })
    await band.unmount()
    await clock.advance(1000)
    return line()
  }
  for (const columns of [40, 60, 80, 120, 200]) {
    expect([...(await at(columns))].length).toBeLessThanOrEqual(columns - 4)
  }
  expect(await at(28)).toBe('CTX 42%  5H 23%  7D 12%')
  // every item goes in at its shortest before any gets detail
  expect(await at(64)).toBe('CTX 42%  5H 23%  7D 12%  ⬢ opus-5-5  $ 1.23  ⚙ 0/0 agents')
})

test('/hud opens the card and blanks the line; ▿ line brings the line back', async ($, on) => {
  const { clock, line } = engine(on)
  await start($)
  await clock.advance(1000)
  expect(line()).toMatch(/^CTX/)

  await $.command.run({ command: 'hud', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await clock.advance(1000)
  expect(line()).toBe('')

  const ui = await $.ui.mount({ plugin: 'spark-hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /42%/ })).toBeDefined()
  expect(await ui.find({ text: /23%/ })).toBeDefined()
  expect(await ui.find({ text: /1\.23/ })).toBeDefined()

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'theme' })).toBeDefined()
  expect(await ui.find({ text: /autocompact|No reading|pace|↻/ })).toBeDefined()

  // the theme stays put over time and changes only on a press
  const before = (await ui.findAll({ text: /theme Claude/ })).length
  await ui.advance(20 * 60 * 1000)
  expect((await ui.findAll({ text: /theme Claude/ })).length).toBe(before)
  await ui.press({ key: 'theme' })
  expect(await ui.find({ text: /theme Black & Red/ })).toBeDefined()
  for (let i = 0; i < 6; i += 1) await ui.press({ key: 'theme' })
  expect(await ui.find({ text: /theme Claude/ })).toBeDefined()

  await ui.press({ key: 'ultra-off' })
  expect(await ui.find({ text: /engine band/ })).toBeDefined()
  await clock.advance(1000)
  expect(line()).toMatch(/^CTX/)
  await ui.unmount()
})
