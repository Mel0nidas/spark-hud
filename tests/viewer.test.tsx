import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 20 }

test('clicking an agent opens its live transcript', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'map auth call sites', type: 'Explore', status: 'running' }],
  }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Find every caller of verifySession', toolUses: [] },
      {
        role: 'assistant',
        text: 'Searching the codebase.',
        toolUses: [
          { tool_use_id: 't1', tool: 'Grep', input: { pattern: 'verifySession' }, text: 'src/auth.ts\nsrc/api.ts' },
          { tool_use_id: 't2', tool: 'Read', input: { file_path: 'src/auth.ts' } },
        ],
      },
    ],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({ text: '' }))

  // a finished subagent turn makes the HUD refresh its agent list
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' })

  // the HUD starts as one line in the status line; /hud opens the card
  await $.command.run({ command: 'hud', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: SCROLL, view: {} },
  })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'agent-a1' })

  const pane = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'spark-hud-agent',
    props: { title: 'Agent', isFocused: true, bodyColumns: 110, placement: 'inline', scroll: SCROLL, view: {} },
  })
  expect(await pane.find({ text: /Find every caller of verifySession/ })).toBeDefined()
  expect(await pane.find({ text: /Searching the codebase/ })).toBeDefined()
  expect(await pane.find({ text: /Grep verifySession/ })).toBeDefined()
  expect(await pane.find({ text: /\+1 lines/ })).toBeDefined()
  expect(await pane.find({ text: /Read auth\.ts/ })).toBeDefined()
})
