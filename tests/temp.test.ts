import { expect, mock, test } from 'claude-code/testing'

import { flat } from './render'

// The TEMP gauge: how long the prompt cache stays warm after a reply, one toast before it
// goes cold, and the cacheTtl setting.

const MIN = 60_000
const USAGE = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 4000 }
const BAND = {
  plugin: 'spark-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

type On = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

function setup(on: On) {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 244_000, window: 1_000_000, percent: 24 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  mock.env(on, { HOME: '/h' })
  return { clock, toasts }
}

const turn = (id: string) => ({ answer: '', durationMs: 1000, isAborted: false, turnId: id, reason: 'answer', usage: USAGE }) as const

// animation off: a tick every 15 s at rest, and the band is mounted only to look at it,
// so hours on the mocked clock stay quick; two simulated hours still take a few seconds
test('TEMP: a dash before the first reply, warm while working, then it counts down and goes cold', { options: { animation: 'off' }, timeoutMs: 60_000 }, async ($, on) => {
  const { clock, toasts } = setup(on)
  const look = async (surface: 'terminal' | 'desktop' = 'terminal', press?: string) => {
    const band = await $.ui.mount({ surface, ...BAND })
    if (press) await band.press({ key: press })
    const text = flat(await band.drawn())
    await band.unmount()
    return text
  }
  const colds = () => toasts.filter(t => /cold/.test(t)).length
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(await look()).toMatch(/TEMP\s+\S* —/)
  expect(await look('desktop')).toMatch(/TEMP.*—/)

  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  expect(await look()).toMatch(/TEMP\s+\S* warm/)
  await $.turn.complete(turn('t1'))
  await clock.advance(1000)
  expect(await look()).toMatch(/TEMP\s+\S* 60m/)

  await clock.advance(50 * MIN)
  // the clock on screen moves with the 15 s tick
  expect(await look()).toMatch(/TEMP\s+\S* 1[01]m/)
  expect(colds()).toBe(0)

  // two minutes before: one toast, and only one
  await clock.advance(8 * MIN + 30_000)
  expect(colds()).toBe(1)
  await clock.advance(MIN)
  expect(colds()).toBe(1)

  await clock.advance(2 * MIN)
  expect(await look()).toMatch(/TEMP\s+\S* cold/)
  // expanded: what the cold cache costs
  expect(await look('terminal', 'toggle')).toMatch(/writes all 244k again/)

  // a new reply warms it again, and arms a new toast
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete(turn('t2'))
  await clock.advance(1000)
  expect(await look()).toMatch(/reads 244k from cache/)
  await clock.advance(59 * MIN)
  expect(colds()).toBe(2)
})

test('TEMP with a 5-minute cache', { options: { cacheTtl: '5m', animation: 'off' } }, async ($, on) => {
  const { clock, toasts } = setup(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ surface: 'terminal', ...BAND })
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete(turn('t1'))
  await clock.advance(1000)
  expect(flat(await band.drawn())).toMatch(/TEMP\s+\S* 5m/)
  await clock.advance(3 * MIN + 30_000)
  expect(toasts.filter(t => /cold/.test(t))).toEqual([])
  await clock.advance(MIN)
  expect(toasts.filter(t => /cold/.test(t)).length).toBe(1)
  await clock.advance(MIN)
  expect(flat(await band.drawn())).toMatch(/TEMP\s+\S* cold/)
})
