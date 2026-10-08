import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityFilter, GitInfo, PaneTab, PrInfo, Task, TaskStatus, UsageInfo } from '../types'
import { classifyToolCall } from './lib/classify'
import { clockTime, duration, truncate } from './lib/format'
import {
  KIND_ICON,
  activityItems,
  fitSegments,
  matchesFilter,
  statusSegments,
  type PaneTarget,
  type Piece,
  type Tone,
} from './lib/layout'
import { parseGitStatus, parsePrView } from './lib/parse'

const PANE = 'painel'
const MAX_ACTIVITY = 200
const MAX_OUTPUT_CHARS = 20_000
const OUTPUT_PREVIEW_LINES = 40
const GIT_EVERY_MS = 10_000
const PR_EVERY_MS = 60_000
const TICK_MS = 1_000
const ACTIVITY_HOTKEY_WIDTH = 'a: atividade'.length + 3

const activity = atom({ plugin: 'painel', key: 'activity' } as const, [] as Activity[])
const unseenCritical = atom({ plugin: 'painel', key: 'unseenCritical' } as const, [] as string[])
const tasks = atom({ plugin: 'painel', key: 'tasks' } as const, [] as Task[])
const git = atom({ plugin: 'painel', key: 'git' } as const, null as GitInfo | null)
const pr = atom({ plugin: 'painel', key: 'pr' } as const, null as PrInfo | null)
const usage = atom({ plugin: 'painel', key: 'usage' } as const, null as UsageInfo | null)
const startedAt = atom({ plugin: 'painel', key: 'startedAt' } as const, 0)
const turns = atom({ plugin: 'painel', key: 'turns' } as const, 0)
const now = atom({ plugin: 'painel', key: 'now' } as const, 0)
const tab = atom({ plugin: 'painel', key: 'tab' } as const, 'activity' as PaneTab)
const filter = atom({ plugin: 'painel', key: 'filter' } as const, 'all' as ActivityFilter)
const expanded = atom({ plugin: 'painel', key: 'expanded' } as const, null as string | null)
const showFullOutput = atom({ plugin: 'painel', key: 'showFullOutput' } as const, false)

const TONE_STYLE: Record<Tone, { color?: string; dimColor?: boolean }> = {
  normal: {},
  dim: { dimColor: true },
  warn: { color: 'warning' },
  high: { color: 'error' },
  mcp: { color: 'magenta' },
  cli: { color: 'cyan' },
}

const FILTER_LABEL: Record<ActivityFilter, string> = { all: 'todos', critical: '⚠', mcp: '◆', cli: '⚙' }

const GIT_TOUCHING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash'])

type Engine = EngineInterface

async function refreshUsage($: Engine): Promise<void> {
  const figures = await $.session.usage()
  await update($, usage, () => ({
    contextTokens: figures.context.tokens,
    contextWindow: figures.context.window,
    contextPercent: figures.context.percent,
    limits: figures.rateLimits.map(limit => ({
      kind: limit.kind,
      percent: limit.percentUsed,
      resetsAt: limit.resetsAt,
    })),
  }))
}

async function refreshGit($: Engine): Promise<GitInfo | null> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
    if (top.exitCode !== 0) {
      await update($, git, () => null)
      return null
    }
    const status = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5_000 })
    const info = status.exitCode === 0 ? parseGitStatus(status.stdout, top.stdout) : null
    await update($, git, () => info)
    return info
  } catch {
    await update($, git, () => null)
    return null
  }
}

async function refreshPr($: Engine): Promise<void> {
  if ((await read($, git)) === null) {
    await update($, pr, () => null)
    return
  }
  try {
    const view = await $.process.run(['gh', 'pr', 'view', '--json', 'number,reviewDecision,statusCheckRollup'], {
      timeoutMs: 15_000,
    })
    if (view.exitCode === 0) {
      await update($, pr, () => parsePrView(view.stdout))
    } else {
      const hasNoPr = /no (?:open )?pull requests? found/i.test(view.stderr)
      await update($, pr, () => (hasNoPr ? { state: 'none' } : null))
    }
  } catch {
    await update($, pr, () => null)
  }
}

async function openPane($: Engine, target: PaneTarget): Promise<void> {
  await update($, tab, () => target.tab)
  if (target.filter) await update($, filter, () => target.filter!)
  if (target.expand) await update($, expanded, () => target.expand!)
  await update($, unseenCritical, () => [])
  await $.ui.open({ id: PANE, title: 'Painel', focus: true, closeOnEscape: true })
}

function recordTask(list: Task[], id: string, change: Partial<Task>): Task[] {
  const exists = list.some(task => task.id === id)
  if (!exists) return [...list, { id, subject: change.subject ?? id, status: change.status ?? 'pending' }]
  return list.map(task => (task.id === id ? { ...task, ...change } : task))
}

let lastBranch: string | undefined
let ticker: { cancel: () => void } | undefined

async function syncGit($: Engine): Promise<void> {
  const info = await refreshGit($)
  if (info && info.branch !== lastBranch) {
    lastBranch = info.branch
    await update($, pr, () => ({ state: 'loading' }))
    await refreshPr($)
  }
}

function ensureTicker($: Engine): void {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      await update($, now, () => Date.now())
      const list = await read($, activity)
      if (!list.some(entry => entry.status === 'running')) {
        ticker?.cancel()
        ticker = undefined
      }
    })()
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'painel', description: 'Abre o painel de atividade e tarefas' })
    const figures = await $.session.usage()
    await update($, startedAt, () => figures.startedAt)
    await update($, now, () => Date.now())
    await refreshUsage($)
    await syncGit($)
    $.clock.every(GIT_EVERY_MS, () => void syncGit($))
    $.clock.every(PR_EVERY_MS, () => void refreshPr($))
    $.clock.every(60_000, () => void update($, now, () => Date.now()))
    return result
  })

  on('command.run', { command: 'painel' }, async $ => {
    await openPane($, { tab: 'activity' })
    return { text: 'Painel aberto.' }
  })

  on('session.measure', async ($, e, next) => {
    await refreshUsage($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, turns, count => count + 1)
    await update($, now, () => Date.now())
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const classified = classifyToolCall(String(e.tool), input)
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const started = Date.now()

    await update($, activity, list =>
      [...list, { id, startedAt: started, status: 'running' as const, ...classified }].slice(-MAX_ACTIVITY),
    )
    await update($, now, () => started)
    ensureTicker($)

    const ran = await next(e)

    const isError = ran.deny !== undefined || ran.isError === true
    const output = (ran.deny ?? ran.text ?? '').slice(0, MAX_OUTPUT_CHARS)
    await update($, activity, list =>
      list.map(entry =>
        entry.id === id
          ? { ...entry, status: isError ? ('error' as const) : ('ok' as const), ms: Date.now() - started, output }
          : entry,
      ),
    )
    if (classified.kind === 'critical') {
      await update($, unseenCritical, ids => [...ids, id])
    }

    const created = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
    if (e.tool === 'TaskCreate' && created) {
      await update($, tasks, list => recordTask(list, created.id, { subject: created.subject, status: 'pending' }))
    } else if (e.tool === 'TaskUpdate' && e.status) {
      const status = e.status
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(task => task.id !== e.taskId)
          : recordTask(list, e.taskId, { status, ...(e.subject ? { subject: e.subject } : {}) }),
      )
    } else if (e.tool === 'TodoWrite') {
      await update($, tasks, () =>
        e.todos.map((todo, index) => ({ id: `todo-${index}`, subject: todo.content, status: todo.status as TaskStatus })),
      )
    }

    if (GIT_TOUCHING_TOOLS.has(String(e.tool))) void syncGit($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const currentTime = (await read($, now)) || Date.now()

    const renderPiece = (piece: Piece, key: string) => (
      <Text key={key} bold={piece.bold} {...TONE_STYLE[piece.tone ?? 'normal']}>
        {piece.text}
      </Text>
    )

    const segments = fitSegments(
      statusSegments({
        usage: await read($, usage),
        git: await read($, git),
        pr: await read($, pr),
        tasks: await read($, tasks),
        unseenCritical: (await read($, unseenCritical)).length,
        startedAt: await read($, startedAt),
        turns: await read($, turns),
        now: currentTime,
      }),
      width,
    )

    const statusLine = (
      <Box gap={2}>
        {segments.map(segment =>
          segment.target ? (
            <Button
              key={`seg-${segment.id}`}
              plain
              label={segment.pieces.map(piece => piece.text).join('')}
              onPress={() => void openPane($, segment.target!)}
            />
          ) : (
            <Box key={`seg-${segment.id}`}>{segment.pieces.map((piece, index) => renderPiece(piece, `${segment.id}-${index}`))}</Box>
          ),
        )}
      </Box>
    )

    const items = activityItems(
      await read($, activity),
      await read($, unseenCritical),
      Math.max(0, width - ACTIVITY_HOTKEY_WIDTH),
      currentTime,
    )

    const activityLine = (
      <Box columnGap={3}>
        {items.map(item => (
          <Box key={`item-${item.activity.id}`}>
            {renderPiece(item.icon, `icon-${item.activity.id}`)}
            <Text> </Text>
            <Button
              key={`open-${item.activity.id}`}
              plain
              dimColor={item.activity.kind === 'plain' && item.activity.status === 'ok' ? true : undefined}
              label={item.label}
              onPress={() => void openPane($, { tab: 'activity', filter: 'all', expand: item.activity.id })}
            />
            {item.suffix && renderPiece(item.suffix, `suffix-${item.activity.id}`)}
          </Box>
        ))}
        <Button key="open-activity" plain hotkey="a" label="atividade" onPress={() => void openPane($, { tab: 'activity' })} />
      </Box>
    )

    const below = await next(e)
    return (
      <Box flexDirection="column">
        {statusLine}
        {activityLine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const currentTab = await read($, tab)
    const currentFilter = await read($, filter)
    const list = await read($, activity)
    const taskList = await read($, tasks)
    const expandedId = await read($, expanded)
    const isFullOutput = await read($, showFullOutput)

    const tabs = (
      <Box gap={2}>
        <Button key="tab-activity" plain hotkey="1" label={currentTab === 'activity' ? '● Atividade' : 'Atividade'} onPress={() => void update($, tab, () => 'activity')} />
        <Button key="tab-tasks" plain hotkey="2" label={`${currentTab === 'tasks' ? '● ' : ''}Tarefas (${taskList.length})`} onPress={() => void update($, tab, () => 'tasks')} />
      </Box>
    )

    if (currentTab === 'tasks') {
      const glyph = { pending: '☐', in_progress: '◐', completed: '☑' } as const
      return (
        <Box flexDirection="column">
          {tabs}
          {taskList.length === 0 && <Text dimColor>Nenhuma tarefa nesta sessão.</Text>}
          {taskList.map(task => (
            <Text key={`task-${task.id}`} dimColor={task.status === 'completed'} color={task.status === 'in_progress' ? 'warning' : undefined}>
              {glyph[task.status]} {truncate(task.subject, width - 2)}
            </Text>
          ))}
        </Box>
      )
    }

    const count = (kind: ActivityFilter) => list.filter(entry => matchesFilter(entry, kind)).length
    const filters = (
      <Box gap={1}>
        {(['all', 'critical', 'mcp', 'cli'] as const).map(kind => (
          <Button
            key={`filter-${kind}`}
            variant={currentFilter === kind ? 'primary' : undefined}
            label={`${FILTER_LABEL[kind]} ${count(kind)}`}
            onPress={() => void update($, filter, () => kind)}
          />
        ))}
      </Box>
    )

    const rows = [...list].reverse().filter(entry => matchesFilter(entry, currentFilter))
    const labelWidth = Math.max(10, width - 6 - 2 - 8)

    return (
      <Box flexDirection="column">
        {tabs}
        {filters}
        {rows.length === 0 && <Text dimColor>Nada por aqui ainda.</Text>}
        {rows.map(entry => {
          const isOpen = entry.id === expandedId
          const status =
            entry.status === 'running' ? (
              <Text color="warning">▶</Text>
            ) : entry.status === 'error' ? (
              <Text color="error">✗</Text>
            ) : (
              <Text color="success">✓</Text>
            )
          const icon = KIND_ICON[entry.kind]
          const outputLines = (entry.output ?? '').split('\n')
          const shownOutput = isFullOutput ? outputLines : outputLines.slice(0, OUTPUT_PREVIEW_LINES)
          return (
            <Box key={`row-${entry.id}`} flexDirection="column">
              <Box>
                <Text dimColor>{clockTime(entry.startedAt)} </Text>
                <Text
                  color={entry.kind === 'critical' ? 'error' : entry.kind === 'mcp' ? 'magenta' : entry.kind === 'cli' ? 'cyan' : undefined}
                  bold={entry.kind === 'critical'}
                  dimColor={entry.kind === 'plain'}
                >
                  {icon}{' '}
                </Text>
                <Button
                  key={`toggle-${entry.id}`}
                  plain
                  label={truncate(entry.label, labelWidth)}
                  onPress={() =>
                    void (async () => {
                      await update($, showFullOutput, () => false)
                      await update($, expanded, current => (current === entry.id ? null : entry.id))
                    })()
                  }
                />
                <Text> </Text>
                {status}
                <Text dimColor> {entry.ms === undefined ? '' : duration(entry.ms).padStart(5)}</Text>
              </Box>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={6}>
                  <Text>{entry.detail}</Text>
                  {entry.output ? (
                    <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
                      <Text dimColor>{shownOutput.join('\n')}</Text>
                    </Box>
                  ) : (
                    <Text dimColor>(sem saída)</Text>
                  )}
                  {!isFullOutput && outputLines.length > OUTPUT_PREVIEW_LINES && (
                    <Button key={`full-${entry.id}`} label={`ver tudo (${outputLines.length} linhas)`} onPress={() => void update($, showFullOutput, () => true)} />
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
