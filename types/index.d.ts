export type ActivityKind = 'critical' | 'mcp' | 'cli' | 'plain'

export type ActivityStatus = 'running' | 'ok' | 'error'

export type ActivityCategory = 'edit' | 'action' | 'read'

export type RequestGroup = { id: string; text: string; startedAt: number }

export type Activity = {
  id: string
  startedAt: number
  kind: ActivityKind
  tool?: string
  category: ActivityCategory
  groupId: string
  label: string
  detail: string
  status: ActivityStatus
  ms?: number
  output?: string
  stat?: string
  sql?: string
  isMcp?: true
  file?: FileChange
  files?: FileChange[]
  gitNote?: string
}

export type FileChange = { path: string; content?: string; diff?: string }

/** Uma troca num arquivo, no registro próprio da aba Arquivos (sem o limite da lista de atividade). */
export type FileEvent = FileChange & { id: string; at?: number }

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

export type PaneTab = 'activity' | 'tasks' | 'files'

export type ActivityFilter = 'all' | 'edit' | 'action' | 'read' | 'critical'

export type PaneMode = 'compact' | 'full'

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
      fileLog: FileEvent[]
      /** Raízes de repositório git dos arquivos editados, para mostrar caminhos a partir do projeto. */
      projectRoots: string[]
      requests: RequestGroup[]
      showReads: boolean
      toggledGroups: string[]
      readsOpenIn: string[]
    }
  }
}
