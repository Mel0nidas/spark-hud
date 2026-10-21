#!/usr/bin/env node
// Spark HUD's status line command: prints the one-line HUD the mod writes for
// this session to ~/.claude/spark-hud/line/<session_id>.ansi. Until the mod has
// written it (or with the mod off), it prints the context and limits from the
// status line's own input instead.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  // no input: fall through to an empty line
}

const id = typeof input.session_id === 'string' && /^[\w-]+$/.test(input.session_id) ? input.session_id : ''
let line
if (id) {
  try {
    line = readFileSync(join(homedir(), '.claude', 'spark-hud', 'line', `${id}.ansi`), 'utf8')
  } catch {
    // not written yet
  }
}

if (line === undefined) {
  const pct = (n) => (typeof n === 'number' ? `${Math.round(n)}%` : null)
  const parts = [
    ['CTX', pct(input.context_window?.used_percentage)],
    ['5H', pct(input.rate_limits?.five_hour?.used_percentage)],
    ['7D', pct(input.rate_limits?.seven_day?.used_percentage)],
  ].filter(([, value]) => value !== null)
  line = parts.map(([label, value]) => `\x1b[1;38;2;217;119;87m${label}\x1b[0m ${value}`).join('  ')
}

if (line) process.stdout.write(`${line}\n`)
