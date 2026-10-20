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

export type HudPeer = {
  id: string
  project: string
  model: string
  ctxPercent?: number
  fiveHour?: number
  working: boolean
  lastAction: string
  agentsRunning: number
  updatedAt: number
  ended?: boolean
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
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  celebrateUntil: number
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
    }
  }
}
