export type ActivityKind = 'critical' | 'mcp' | 'cli' | 'plain'

export type ActivityStatus = 'running' | 'ok' | 'error'

export type Activity = {
  id: string
  startedAt: number
  kind: ActivityKind
  label: string
  detail: string
  status: ActivityStatus
  ms?: number
  output?: string
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; subject: string; status: TaskStatus }

export type GitInfo = {
  repo: string
  branch: string
  changed: number
  ahead: number
  behind: number
}

export type CheckState = 'pass' | 'fail' | 'pending'

export type PrInfo =
  | { state: 'loading' }
  | { state: 'none' }
  | {
      state: 'open'
      number: number
      checks: CheckState[]
      review: 'approved' | 'changes' | null
    }

export type LimitReading = { kind: string; percent: number; resetsAt?: string }

export type UsageInfo = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: LimitReading[]
}

export type PaneTab = 'activity' | 'tasks'

export type ActivityFilter = 'all' | 'critical' | 'mcp' | 'cli'

export type PaneMode = 'compact' | 'full'

export type Thumbnail = { n: number; columns: number; rows: number; cells: string | null }

declare module 'claude-code' {
  interface PluginState {
    painel: {
      activity: Activity[]
      unseenCritical: string[]
      tasks: Task[]
      git: GitInfo | null
      pr: PrInfo | null
      usage: UsageInfo | null
      startedAt: number
      turns: number
      now: number
      tab: PaneTab
      filter: ActivityFilter
      expanded: string | null
      showFullOutput: boolean
      paneMode: PaneMode
      sideListShown: boolean
      sideListDismissed: boolean
      toolsInChat: boolean
      thumbnails: Thumbnail[]
    }
  }
}
