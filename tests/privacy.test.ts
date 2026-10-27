import { expect, mock, test } from 'claude-code/testing'

const base = (p: string) => p.split(/[\\/]/).pop() ?? ''
const SECRET = 'curl -H "Authorization: Bearer sk-live-123" https://internal.example'

test('other windows get no commands, stale files are blanked, peer files cannot inject', async ($, on) => {
  const clock = mock.clock(on)
  const at = 0 // mock.clock starts the engine's clock at 0
  const files = new Map<string, { text: string; mtimeMs: number }>([
    // a file spark-hud 0.4 left behind, with the start of a Bash command in it
    ['old.json', { text: JSON.stringify({ id: 'old', lastAction: 'Bash: export TOKEN=abc', updatedAt: 0 }), mtimeMs: at - 3600_000 }],
    // a hostile or broken peer: escape codes, a huge percentage, the wrong types
    ['evil.json', { text: JSON.stringify({ id: 'evil', project: '\u001b[2J\u001b]52;c;cHduZWQ=\u0007proj', model: 'm', ctxPercent: 9999, working: 'yes', activity: 'x', agentsRunning: -5, updatedAt: at }), mtimeMs: at }],
    ['junk.json', { text: '{not json', mtimeMs: at }],
  ])
  const writes: { path: string; text: string }[] = []

  mock.env(on, { HOME: '/home/u' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({
    value: [...files].map(([name, f]) => ({ name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  on('fs.read', ($, e) => ({ value: files.get(base(e.path))?.text ?? '' }))
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    files.set(base(e.path), { text: e.text, mtimeMs: at })
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/work/project-x' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  await $.session.start({ cwd: '/work/project-x', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'deploy', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: SECRET })

  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 39 }, view: {} },
  })
  await clock.advance(6000)

  // the stale 0.4 file was blanked, then taken over as this session's own file
  expect(writes.some(w => base(w.path) === 'old.json' && w.text === '{"ended":true}')).toBe(true)
  const mine = writes.filter(w => base(w.path) === 'old.json' && w.text !== '{"ended":true}')
  expect(mine.length).toBeGreaterThan(0)
  for (const w of writes) {
    expect(w.text.includes('sk-live')).toBe(false)
    expect(w.text.includes('curl')).toBe(false)
    expect(w.text.includes('/work')).toBe(false)
  }
  expect(mine.at(-1)!.text.includes('"activity":"Bash"')).toBe(true)

  // the hostile peer shows, cleaned and clamped
  await band.press({ key: 'toggle' })
  expect(await band.find({ text: /\[2J\]52;c;cHduZWQ=proj/ })).toBeDefined()
  expect(await band.find({ text: /\u001b/ })).toBeUndefined()
  expect(await band.find({ text: /ctx 100%/ })).toBeDefined()
  expect(await band.find({ text: /OTHER WINDOWS/ })).toBeDefined()
})

test('with sharing off nothing is written or read', { options: { shareWithOtherWindows: false } }, async ($, on) => {
  const clock = mock.clock(on)
  let touched = 0
  on('fs.write', () => {
    touched += 1
    return { value: undefined }
  })
  on('fs.list', () => {
    touched += 1
    return { value: [] }
  })
  on('fs.exists', () => ({ value: true }))
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: 'me' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work/project-x', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  })
  await clock.advance(60_000)
  expect(touched).toBe(0)
})
