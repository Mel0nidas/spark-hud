import { expect, mock, test } from 'claude-code/testing'

import { show } from './render'

// The avatar through every state and every move between them, read back from the drawn
// tree as pixels (top and bottom of each half-block cell), on the mocked clock.

type El = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isEl = (x: unknown): x is El => typeof x === 'object' && x !== null && 'type' in x

function findAvatar(x: unknown): El | undefined {
  if (!isEl(x)) return undefined
  if (x.type === 'Box' && x.props?.width === 11) return x
  for (const c of x.children ?? []) {
    const hit = findAvatar(c)
    if (hit) return hit
  }
  return undefined
}

/** 8 rows of 11 colors ('' for empty) from the avatar's 4 rows of half-block cells. */
function pixels(tree: unknown): string[][] {
  const box = findAvatar(tree)
  const rows: string[][] = []
  for (const row of (box?.children ?? []).filter(isEl)) {
    const top: string[] = []
    const bottom: string[] = []
    for (const cell of (row.children ?? []).filter(isEl)) {
      const ch = String((cell.children ?? []).join(''))
      const fg = String(cell.props?.color ?? '')
      const bg = String(cell.props?.backgroundColor ?? '')
      top.push(ch === '▀' || ch === '█' ? fg : '')
      bottom.push(ch === '▄' || ch === '█' ? fg : ch === '▀' ? bg : '')
    }
    rows.push(top, bottom)
  }
  return rows
}

const filled = (px: string[][]) => px.flat().filter(Boolean).length
// the thumbs-up is the only sprite with pixels in the bottom-left corner (its sleeve)
const isThumb = (px: string[][]) => Boolean(px[7]?.[0]) && Boolean(px[3]?.[0])

test('avatar: every state and transition, and the thumb leaves on its own', async ($, on) => {
  const clock = mock.clock(on)
  let ctx = 20
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 200_000, percent: ctx }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  mock.env(on, { HOME: '/h' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  const frames: { label: string; px: string[][] }[] = []
  const grab = async (label: string) => {
    const px = pixels(await band.drawn())
    frames.push({ label, px })
    return px
  }
  const run = async (label: string, ms: number, step: number) => {
    const out: string[][][] = []
    for (let t = 0; t < ms; t += step) {
      await clock.advance(step)
      out.push(await grab(`${label} ${t + step}`))
    }
    return out
  }

  await clock.advance(1000)
  const idle = await run('idle', 6000, 1000)
  expect(idle.every(px => filled(px) > 20 && !isThumb(px))).toBe(true)

  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await grab('wake 0')
  const dance = await run('work', 2400, 110)
  // it moves: not every working frame is the same picture
  expect(new Set(dance.map(px => JSON.stringify(px))).size).toBeGreaterThan(2)

  await $.turn.complete({ answer: '', durationMs: 3000, isAborted: false, turnId: 't1', reason: 'answer' })
  await grab('done 0')
  const done = await run('done', 6000, 110)
  const thumbAt = done.map(isThumb)
  // the thumbs-up comes in, stays a while, and goes away by itself
  expect(thumbAt.some(Boolean)).toBe(true)
  expect(thumbAt.filter(Boolean).length).toBeGreaterThan(20)
  expect(thumbAt.slice(-5).some(Boolean)).toBe(false)
  // the DONE sign stays after the thumb has left
  expect(await band.find({ text: /DONE/ })).toBeDefined()
  const rest = await run('after', 3000, 1000)
  expect(rest.every(px => !isThumb(px) && filled(px) > 20)).toBe(true)

  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1000)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't2', reason: 'answer' })
  const shake = await run('abort', 900, 110)
  expect(shake.some(px => !isThumb(px))).toBe(true)
  expect(await band.find({ text: /DONE/ })).toBeUndefined()

  ctx = 92
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 92 }, rateLimits: [], changed: ['context'] })
  const sweat = await run('sweat', 3000, 1000)
  expect(sweat.some(px => px.flat().includes('#6C9BC8'))).toBe(true)

  show(`AVATAR_FRAMES ${JSON.stringify(frames)}`)
})

test('avatar, motion off: still pictures, and the thumb still leaves', { options: { animation: 'off' } }, async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  mock.env(on, { HOME: '/h' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'spark-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1000)
  const working = pixels(await band.drawn())
  await clock.advance(3000)
  expect(pixels(await band.drawn())).toEqual(working)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(1000)
  expect(isThumb(pixels(await band.drawn()))).toBe(true)
  await clock.advance(6000)
  expect(isThumb(pixels(await band.drawn()))).toBe(false)
})
