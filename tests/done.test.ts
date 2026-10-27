import { expect, mock, test } from 'claude-code/testing'

test('a finished turn shows DONE until the next prompt; an interrupted one does not', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))

  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  })
  expect(await band.find({ text: /DONE/ })).toBeUndefined()

  await $.prompt.submit({ text: 'fix it', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await band.find({ text: /DONE/ })).toBeDefined()
  expect(await band.find({ text: /ready for the next task/ })).toBeDefined()

  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(await band.find({ text: /DONE/ })).toBeUndefined()

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'answer' })
  expect(await band.find({ text: /DONE/ })).toBeUndefined()
})
