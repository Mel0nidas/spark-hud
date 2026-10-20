import { expect, mock, test } from 'claude-code/testing'

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

test('the band shows context, 5h limit and cost, and expands', async ($, on) => {
  mock.clock(on)
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString()
  const reading = {
    startedAt: 0,
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt },
      { kind: 'seven_day', percentUsed: 12 },
    ],
    cost: { usd: 1.23 },
  }
  on('session.usage', () => ({ value: reading }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  await $.session.measure({ ...reading, changed: ['context', 'rateLimits', 'cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'spark-hud', surface, ...BAND })
    expect(await ui.find({ text: /42%/ })).toBeDefined()
    expect(await ui.find({ text: /23%/ })).toBeDefined()
    expect(await ui.find({ text: /1\.23/ })).toBeDefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ key: "theme" })).toBeDefined()
    expect(await ui.find({ text: /autocompact|No reading|pace|↻/ })).toBeDefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ key: "theme" })).toBeUndefined()
    await ui.unmount()
  }
})
