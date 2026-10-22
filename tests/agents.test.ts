import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 11 }

test('a short fullscreen band still shows the agents, and engine forks stay out', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23 },
        { kind: 'seven_day', percentUsed: 12 },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'map auth call sites across the whole repository', type: 'Explore', status: 'running' }],
  }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  // a compaction or classifier fork: an agentId the list never names
  await $.tool.call({ tool: 'Bash', command: 'ping', agentId: 'fork-1' })

  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 60, scroll: SCROLL, view: {} },
  })
  await band.press({ key: 'toggle' })
  expect(await band.find({ text: /AGENTS/ })).toBeDefined()
  expect(await band.find({ key: 'agent-a1' })).toBeDefined()
  expect(await band.find({ key: 'agent-fork-1' })).toBeUndefined()
  expect(await band.find({ text: /1 active \/ 1/ })).toBeDefined()
})
