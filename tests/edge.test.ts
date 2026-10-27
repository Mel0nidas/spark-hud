import { expect, mock, test } from 'claude-code/testing'

import { frame, render, show } from './render'

const SCROLL = { offset: 0, bodyRows: 18 }
const USAGE = { startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [] }

test('agent viewer: a long, messy transcript fits its pane', async ($, on) => {
  mock.clock(on)
  const steps = Array.from({ length: 400 }, (_, i) => ({
    tool_use_id: `t${i}`,
    tool: i % 3 ? 'Bash' : 'mcp__github__search_code',
    input: { command: `echo ${'x'.repeat(i % 50)}\nsecond line` },
    ...(i === 399 ? {} : { text: i % 7 ? `line one\nline two\n${'日本語'.repeat(30)}` : 'Error: boom', isError: i % 7 === 0 }),
  }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'a\nmultiline\ndescription', type: 'Explore', status: 'running' }] }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '\n\n   Find every caller\nand more', toolUses: [] },
      { role: 'assistant', text: '🚀 '.repeat(200), toolUses: steps },
    ] as never,
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' })

  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'agent-a1' })

  const out: string[] = []
  for (const cols of [36, 70, 120]) {
    const pane = await $.ui.mount({
      plugin: 'spark-hud',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'spark-hud-agent',
      props: { title: 'Agent', isFocused: true, bodyColumns: cols, placement: 'inline', scroll: SCROLL, view: {} },
    })
    const r = render(await pane.drawn(), cols)
    out.push(frame(`viewer · ${cols} cols`, r, cols))
    show(out.at(-1)!)
    expect(r.problems).toEqual([])
    expect(r.lines.length).toBeLessThanOrEqual(SCROLL.bodyRows + 2)
    expect(await pane.find({ text: /earlier steps/ })).toBeDefined()
    expect(await pane.find({ text: /Find every caller/ })).toBeDefined()
    expect(await pane.find({ text: /github · search_code/ })).toBeDefined()
    await pane.unmount()
  }
  show(`\n${out.join('\n\n')}\n`)
})

test('desktop surface draws every view', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: new Date(3600_000).toISOString() }] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'scan', type: 'Explore', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({ ...USAGE, changed: ['context'] })
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({
      plugin: 'spark-hud',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: SCROLL, view: {} },
    })
    await band.drawn()
    await band.press({ key: 'toggle' })
    await band.drawn()
    await band.press({ key: 'panel' })
    for (const id of ['spark-hud-panel', 'spark-hud-agent']) {
      const pane = await $.ui.mount({
        plugin: 'spark-hud',
        surface,
        component: 'Pane',
        requestId: id,
        props: { title: 'x', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: SCROLL, view: {} },
      })
      expect(await pane.drawn()).toBeDefined()
      await pane.unmount()
    }
    await band.press({ key: 'toggle' })
    await band.unmount()
  }
})

test('footprint at rest: ten idle minutes stay cheap', async ($, on) => {
  const clock = mock.clock(on)
  const calls = { write: 0, list: 0, usage: 0, agents: 0 }
  mock.env(on, { HOME: '/home/u' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => {
    calls.list += 1
    return { value: [] }
  })
  on('fs.write', () => {
    calls.write += 1
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/w/app' }))
  on('session.usage', () => {
    calls.usage += 1
    return { value: USAGE }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => {
    calls.agents += 1
    return { value: [] }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w/app', surface: 'terminal', isInteractive: true })
  await clock.advance(10 * 60_000)
  show(`footprint, 10 idle minutes: ${JSON.stringify(calls)}`)
  // an unchanged status is rewritten once a minute, not every 5 s
  expect(calls.write).toBeLessThanOrEqual(12)
  // countdowns refresh every 30 s; nothing polls the agent list at rest
  expect(calls.usage).toBeLessThanOrEqual(24)
  expect(calls.agents).toBe(0)
})

test('motion off: no frames, and a slow tick at rest', { options: { animation: 'off' } }, async ($, on) => {
  const clock = mock.clock(on)
  let usage = 0
  on('session.usage', () => {
    usage += 1
    return { value: USAGE }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  mock.env(on, { HOME: '/home/u' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  const before = JSON.stringify(await band.drawn())
  await clock.advance(14_000)
  // no tick fell inside those 14 s, so nothing was redrawn
  expect(JSON.stringify(await band.drawn())).toBe(before)
  expect(usage).toBeLessThanOrEqual(3)
})

test('stale or odd readings: a reset in the past, NaN-free numbers, a bad saved theme', async ($, on) => {
  mock.clock(on, { now: 10 * 3600_000 })
  mock.store(on, { theme: 'not a number' })
  on('session.usage', () => ({
    value: {
      startedAt: 10 * 3600_000,
      context: { tokens: 0, window: 0, percent: 0 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 40, resetsAt: new Date(3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 0, resetsAt: new Date(11 * 3600_000).toISOString() },
      ],
    },
  }))
  on('session.model', () => ({ value: '' }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  mock.env(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: SCROLL, view: {} },
  })
  await band.press({ key: 'toggle' })
  const r = render(await band.drawn(), 120)
  show(frame('odd readings', r, 120))
  const text = r.lines.join('\n')
  expect(text.includes('NaN')).toBe(false)
  expect(text.includes('undefined')).toBe(false)
  expect(text.includes('Infinity')).toBe(false)
  expect(await band.find({ text: /theme Claude/ })).toBeDefined()
})
