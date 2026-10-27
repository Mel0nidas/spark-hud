export type HudLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type HudUsage = {
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  limits: HudLimit[]
  costUsd?: number
  model: string
}

export type HudCategory = { name: string; tokens: number; kind: string }

export type HudBreakdown = {
  categories: HudCategory[]
  total: number
  max: number
  autoCompactAt?: number
  isAutoCompact: boolean
}

export type HudAgent = {
  id: string
  name: string
  type: string
  description: string
  status: string
  lastAction: string
  tools: number
  startedAt: number
  updatedAt: number
  ctxTokens?: number
  model?: string
}

export type HudViewRow = {
  kind: 'task' | 'text' | 'tool'
  text: string
  detail?: string
  isError?: boolean
  isPending?: boolean
}

/** What one window shares with the others: no commands, paths, prompts or output. */
export type HudPeer = {
  id: string
  project: string
  model: string
  ctxPercent?: number
  working: boolean
  /** The bare name of the tool last used ('Bash', 'Read', 'MCP'), never its input. */
  activity: string
  agentsRunning: number
  updatedAt: number
}

export type HudStats = {
  startedAt: number
  turns: number
  working: boolean
  turnStartedAt: number
  lastTurnMs?: number
  lastTurnTools: number
  turnTools: number
  toolCalls: number
  lastAction: string
  /** The bare tool name behind lastAction, the only part shared with other windows. */
  lastTool?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Ticks stay fast until then: a transition is playing. */
  celebrateUntil: number
  /** When the last turn finished (0: a new one started); the done sequence plays from it. */
  doneAt?: number
  /** When the last turn was interrupted: the head shake plays from it. */
  abortAt?: number
  /** The last turn finished and no prompt has been sent since: the DONE sign shows. */
  isReady?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'spark-hud': {
      frame: number
      now: number
      isExpanded: boolean
      usage: HudUsage | null
      breakdown: HudBreakdown | null
      agents: HudAgent[]
      peers: HudPeer[]
      stats: HudStats
      theme: number
      viewerAgent: string | null
      viewerRows: HudViewRow[]
      motion: string
    }
  }
}
