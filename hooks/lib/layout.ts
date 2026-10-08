import type { Activity, ActivityCategory, ActivityFilter, GitInfo, PaneTab, PrInfo, RequestGroup, Task, UsageInfo } from '../../types'
import {
  LIMIT_WINDOWS,
  bar,
  compactTokens,
  contextGlyph,
  contextLevel,
  duration,
  limitLevel,
  sessionClock,
  truncate,
  type Level,
} from './format'

export type Tone = 'normal' | 'dim' | 'warn' | 'high' | 'mcp' | 'cli'

export type Piece = { text: string; tone?: Tone; bold?: boolean }

export type PaneTarget = { tab: PaneTab; filter?: ActivityFilter; expand?: string }

export type Segment = {
  id: string
  priority: number
  pieces: Piece[]
  compact?: Piece[]
  target?: PaneTarget
}

export const KEEP = 100
const MAX_REPO = 18
const MAX_BRANCH = 26
const SEGMENT_GAP = 2

export const CATEGORY_ICON: Record<ActivityCategory, string> = { edit: '✎', action: '▶', read: '·' }

const START_GROUP = 'inicio'

function changedSomething(activity: Activity): boolean {
  return activity.file !== undefined || (activity.files?.length ?? 0) > 0 || activity.stat !== undefined
}

/**
 * Entradas gravadas antes da v2 não têm tipo nem pedido. Edição é só o que mudou arquivo (tem `+N −M`):
 * um comando que parecia editar (heredoc, `python -`) e terminou sem mudar nada conta como ação.
 */
export function categoryOf(activity: Activity): ActivityCategory {
  const category = activity.category ?? (activity.kind === 'plain' ? 'read' : 'action')
  if (category === 'edit' && activity.status !== 'running' && !changedSomething(activity)) return 'action'
  return category
}

export function groupIdOf(activity: Activity): string {
  return activity.groupId ?? START_GROUP
}

export function iconFor(activity: Activity): Piece {
  if (activity.status === 'running') return { text: '◌', tone: 'warn' }
  if (activity.status === 'error') return { text: '✗', tone: 'high' }
  if (activity.kind === 'critical') return { text: '⚠', tone: 'high', bold: true }
  const category = categoryOf(activity)
  if (category === 'edit') return { text: CATEGORY_ICON.edit, tone: 'warn' }
  if (category === 'read') return { text: CATEGORY_ICON.read, tone: 'dim' }
  return activity.isMcp || activity.kind === 'mcp' ? { text: '◆', tone: 'mcp' } : { text: CATEGORY_ICON.action, tone: 'cli' }
}

const CHECK_GLYPH = { pass: '✓', fail: '✗', pending: '⏳' } as const
const MAX_CHECK_GLYPHS = 5

function levelTone(level: Level): Tone {
  return level === 'high' ? 'high' : level === 'warn' ? 'warn' : 'normal'
}

export function piecesWidth(pieces: Piece[]): number {
  return pieces.reduce((sum, piece) => sum + piece.text.length, 0)
}

function lineWidth(segments: Segment[]): number {
  const gaps = Math.max(0, segments.length - 1) * SEGMENT_GAP
  return segments.reduce((sum, segment) => sum + piecesWidth(segment.pieces), gaps)
}

export function fitSegments(segments: Segment[], width: number): Segment[] {
  let fitted = segments.map(segment => ({ ...segment }))
  while (lineWidth(fitted) > width) {
    const candidates = fitted.filter(segment => segment.priority < KEEP)
    if (candidates.length === 0) break
    const weakest = candidates.reduce((low, segment) => (segment.priority < low.priority ? segment : low))
    fitted = weakest.compact
      ? fitted.map(segment => (segment === weakest ? { ...segment, pieces: segment.compact!, compact: undefined } : segment))
      : fitted.filter(segment => segment !== weakest)
  }
  return fitted
}

export type StatusData = {
  usage: UsageInfo | null
  git: GitInfo | null
  pr: PrInfo | null
  tasks: Task[]
  unseenCritical: number
  startedAt: number
  turns: number
  now: number
}

function usageSegments(usage: UsageInfo | null, now: number): Segment[] {
  if (!usage) return []
  const segments: Segment[] = []
  if (usage.contextPercent !== undefined && usage.contextTokens !== undefined) {
    const percent = usage.contextPercent
    segments.push({
      id: 'context',
      priority: KEEP,
      pieces: [
        {
          text: `${contextGlyph(percent)} ${compactTokens(usage.contextTokens)}/${compactTokens(usage.contextWindow)} ${percent}%`,
          tone: levelTone(contextLevel(percent)),
        },
      ],
    })
  }
  for (const limit of usage.limits) {
    const window = LIMIT_WINDOWS[limit.kind]
    if (!window) continue
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
    const tone = levelTone(limitLevel(limit.percent, window.ms, resetsAt, now))
    segments.push({
      id: limit.kind,
      priority: limit.kind === 'five_hour' ? KEEP : 3,
      pieces: [
        { text: `${window.label} `, tone: 'dim' },
        { text: `${bar(limit.percent)} ${Math.round(limit.percent)}%`, tone },
      ],
    })
  }
  return segments
}

function gitSegment(git: GitInfo | null): Segment[] {
  if (!git) return []
  const pieces: Piece[] = [{ text: `⎇ ${truncate(git.repo, MAX_REPO)}·${truncate(git.branch, MAX_BRANCH)}` }]
  if (git.changed > 0) pieces.push({ text: ` ●${git.changed}`, tone: 'dim' })
  if (git.ahead > 0) pieces.push({ text: ` ↑${git.ahead}`, tone: 'dim' })
  if (git.behind > 0) pieces.push({ text: ` ↓${git.behind}`, tone: 'warn' })
  return [{ id: 'git', priority: KEEP, pieces }]
}

function prSegment(pr: PrInfo | null): Segment[] {
  if (!pr) return []
  if (pr.state === 'loading') return [{ id: 'pr', priority: 2, pieces: [{ text: 'PR …', tone: 'dim' }] }]
  if (pr.state === 'none') return [{ id: 'pr', priority: 2, pieces: [{ text: 'sem PR', tone: 'dim' }] }]

  const shown = pr.checks.slice(0, MAX_CHECK_GLYPHS)
  const checkPieces: Piece[] = shown.map(check => ({
    text: CHECK_GLYPH[check],
    tone: check === 'fail' ? 'high' : 'dim',
  }))
  if (pr.checks.length > MAX_CHECK_GLYPHS) {
    checkPieces.push({ text: `+${pr.checks.length - MAX_CHECK_GLYPHS}`, tone: 'dim' })
  }
  const reviewPieces: Piece[] =
    pr.review === 'approved'
      ? [{ text: ' aprovado', tone: 'dim' }]
      : pr.review === 'changes'
        ? [{ text: ' mudanças', tone: 'warn' }]
        : []
  const worst = pr.checks.includes('fail') ? 'fail' : pr.checks.includes('pending') ? 'pending' : 'pass'
  const label = { text: `PR #${pr.number}` }

  return [
    {
      id: 'pr',
      priority: 2,
      pieces: [label, ...(checkPieces.length ? [{ text: ' ' }, ...checkPieces] : []), ...reviewPieces],
      compact: pr.checks.length
        ? [label, { text: ` ${CHECK_GLYPH[worst]}`, tone: worst === 'fail' ? 'high' : 'dim' }]
        : [label],
    },
  ]
}

function tasksSegment(tasks: Task[]): Segment[] {
  if (tasks.length === 0) return []
  const done = tasks.filter(task => task.status === 'completed').length
  const isWorking = tasks.some(task => task.status === 'in_progress')
  return [
    {
      id: 'tasks',
      priority: 4,
      pieces: [{ text: `${isWorking ? '◐' : '☐'} ${done}/${tasks.length}` }],
      target: { tab: 'tasks' },
    },
  ]
}

export function statusSegments(data: StatusData): Segment[] {
  const segments = [...usageSegments(data.usage, data.now), ...gitSegment(data.git), ...prSegment(data.pr), ...tasksSegment(data.tasks)]
  if (data.unseenCritical > 0) {
    segments.push({
      id: 'critical',
      priority: KEEP,
      pieces: [{ text: `⚠ ${data.unseenCritical}`, tone: 'high', bold: true }],
      target: { tab: 'activity', filter: 'critical' },
    })
  }
  if (data.startedAt > 0) {
    segments.push({
      id: 'clock',
      priority: 1,
      pieces: [{ text: `◷ ${sessionClock(data.now - data.startedAt)}·${data.turns}t`, tone: 'dim' }],
    })
  }
  return segments
}

export type ActivityItem = { activity: Activity; icon: Piece; label: string; suffix?: Piece }

export type ActivityGroup = { activity: Activity; count: number }

/** Junta execuções seguidas do mesmo comando com o mesmo resultado; recebe do mais novo ao mais antigo. */
export function groupRepeats(newestFirst: Activity[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const entry of newestFirst) {
    const last = groups[groups.length - 1]
    const isRepeat =
      last !== undefined &&
      entry.status !== 'running' &&
      last.activity.status === entry.status &&
      last.activity.kind === entry.kind &&
      last.activity.label === entry.label
    if (isRepeat) groups[groups.length - 1] = { ...last, count: last.count + 1 }
    else groups.push({ activity: entry, count: 1 })
  }
  return groups
}

export function repeatSuffix(count: number): string {
  return count > 1 ? ` ×${count}` : ''
}

const ITEM_GAP = 3
const MIN_LABEL = 12

function toItem({ activity, count }: ActivityGroup, now: number): ActivityItem {
  const isRunning = activity.status === 'running'
  const icon = iconFor(activity)
  const suffixText = isRunning ? ` ${duration(now - activity.startedAt)}` : repeatSuffix(count)
  const suffix: Piece | undefined = suffixText ? { text: suffixText, tone: 'dim' } : undefined
  return { activity, icon, label: activity.label, suffix }
}

function itemWidth(item: ActivityItem): number {
  return item.icon.text.length + 1 + item.label.length + (item.suffix?.text.length ?? 0)
}

export function activityItems(
  activity: Activity[],
  unseenCritical: string[],
  width: number,
  now: number,
): ActivityItem[] {
  const newestFirst = [...activity].reverse()
  const running = newestFirst.filter(entry => entry.status === 'running')
  const pinned = newestFirst.filter(entry => entry.status !== 'running' && unseenCritical.includes(entry.id))
  const recent = newestFirst.filter(entry => entry.status !== 'running' && !unseenCritical.includes(entry.id))

  const single = (entry: Activity): ActivityGroup => ({ activity: entry, count: 1 })
  const required = [...running.slice(0, 1), ...pinned.slice(0, 3)].map(entry => toItem(single(entry), now))
  const optional = groupRepeats(recent).map(group => toItem(group, now))

  const total = (items: ActivityItem[]) =>
    items.reduce((sum, item) => sum + itemWidth(item), Math.max(0, items.length - 1) * ITEM_GAP)

  const items = [...required]
  for (const item of optional) {
    if (total([...items, item]) <= width) {
      items.push(item)
      continue
    }
    const room = width - total([...items, { ...item, label: '' }])
    if (room >= MIN_LABEL) items.push({ ...item, label: truncate(item.label, room) })
    break
  }

  let labelWidth = Math.max(...items.map(item => item.label.length), MIN_LABEL)
  let shrunk = items
  while (total(shrunk) > width && labelWidth > MIN_LABEL) {
    labelWidth -= 1
    shrunk = items.map(item => ({ ...item, label: truncate(item.label, labelWidth) }))
  }
  return shrunk
}

export function matchesFilter(activity: Activity, filter: ActivityFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'critical') return activity.kind === 'critical'
  return categoryOf(activity) === filter
}

export type CategoryCounts = Record<ActivityCategory, number>

export function countCategories(list: Activity[]): CategoryCounts {
  const counts: CategoryCounts = { edit: 0, action: 0, read: 0 }
  for (const entry of list) counts[categoryOf(entry)] += 1
  return counts
}

export type RequestView = { request: RequestGroup; entries: Activity[]; counts: CategoryCounts }

/** Agrupa as chamadas pelo pedido em que aconteceram; o pedido mais recente vem primeiro. */
export function groupByRequest(activity: Activity[], requests: RequestGroup[]): RequestView[] {
  const known = new Set(requests.map(request => request.id))
  const byGroup = new Map<string, Activity[]>()
  for (const entry of activity) {
    const id = known.has(groupIdOf(entry)) ? groupIdOf(entry) : START_GROUP
    byGroup.set(id, [...(byGroup.get(id) ?? []), entry])
  }
  const start: RequestGroup = { id: START_GROUP, text: 'início da sessão', startedAt: activity[0]?.startedAt ?? 0 }
  return [start, ...requests]
    .filter(request => byGroup.has(request.id))
    .map(request => {
      const entries = byGroup.get(request.id)!
      return { request, entries: [...entries].reverse(), counts: countCategories(entries) }
    })
    .reverse()
}

export function countsLabel(counts: CategoryCounts): string {
  const parts = [
    counts.edit ? `${counts.edit} ${counts.edit === 1 ? 'edição' : 'edições'}` : '',
    counts.action ? `${counts.action} ${counts.action === 1 ? 'ação' : 'ações'}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

export function readsLabel(count: number): string {
  return count === 1 ? '1 leitura' : `${count} leituras`
}

export function sinceLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}min`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

export type WorkSummary = { counts: CategoryCounts; total: number; running: Activity | undefined }

/** O que o Claude fez no pedido atual: some do chat com as ferramentas escondidas, então a faixa conta. */
export function currentWork(activity: Activity[], requests: RequestGroup[]): WorkSummary | null {
  const latest = requests[requests.length - 1]
  if (!latest) return null
  const entries = activity.filter(entry => groupIdOf(entry) === latest.id)
  if (entries.length === 0) return null
  return { counts: countCategories(entries), total: entries.length, running: [...entries].reverse().find(entry => entry.status === 'running') }
}

export function workLabel(work: WorkSummary): string {
  const parts = [countsLabel(work.counts), work.counts.read ? readsLabel(work.counts.read) : ''].filter(Boolean)
  return parts.join(' · ')
}
