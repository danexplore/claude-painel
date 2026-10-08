import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityFilter, FileEvent, GitInfo, PaneMode, PaneTab, PrInfo, RequestGroup, Task, TaskStatus, UsageInfo } from '../types'
import { changesFromResult, classifyToolCall, gitNote, isBookkeeping, settleCategory, type GitOperation } from './lib/classify'
import { cleanText, clockTime, duration, truncate } from './lib/format'
import {
  activityItems,
  categoryOf,
  countCategories,
  countsLabel,
  groupByRequest,
  iconFor,
  readsLabel,
  sinceLabel,
  fitSegments,
  groupRepeats,
  repeatSuffix,
  matchesFilter,
  statusSegments,
  type PaneTarget,
  type Piece,
  type Tone,
} from './lib/layout'
import { parseGitStatus, parsePrView } from './lib/parse'
import { changesStat, filesChanged, homePath, mergeFileEvents } from './lib/files'
import { coloredStat, entryDetail, fileDiff } from './views/detail'

const PANE = 'painel'
const MAX_ACTIVITY = 200
const MAX_OUTPUT_CHARS = 20_000
const OUTPUT_PREVIEW_LINES = 40
const GIT_EVERY_MS = 10_000
const PR_EVERY_MS = 60_000
const TICK_MS = 1_000
const ACTIVITY_HOTKEY_WIDTH = 'a: atividade'.length + 4
const COMPACT_COLUMNS = 42
const FULL_COLUMNS = 100
const COMPACT_TASKS = 5
const INLINE_ROWS = 14
const COMPACT_PREVIEW_LINES = 6
const COMPACT_DETAIL_LINES = 3

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
const paneMode = atom({ plugin: 'painel', key: 'paneMode' } as const, 'compact' as PaneMode)
const sideListShown = atom({ plugin: 'painel', key: 'sideListShown' } as const, false)
const sideListDismissed = atom({ plugin: 'painel', key: 'sideListDismissed' } as const, false)
const toolsInChat = atom({ plugin: 'painel', key: 'toolsInChat' } as const, false)
const fileLog = atom({ plugin: 'painel', key: 'fileLog' } as const, [] as FileEvent[])
const requests = atom({ plugin: 'painel', key: 'requests' } as const, [] as RequestGroup[])
const showReads = atom({ plugin: 'painel', key: 'showReads' } as const, false)
const toggledGroups = atom({ plugin: 'painel', key: 'toggledGroups' } as const, [] as string[])
const readsOpenIn = atom({ plugin: 'painel', key: 'readsOpenIn' } as const, [] as string[])

const TONE_STYLE: Record<Tone, { color?: string; dimColor?: boolean }> = {
  normal: {},
  dim: { dimColor: true },
  warn: { color: 'warning' },
  high: { color: 'error' },
  mcp: { color: 'magenta' },
  cli: { color: 'cyan' },
}

const FILTERS = ['all', 'edit', 'action', 'read', 'critical'] as const
const FILTER_LABEL: Record<ActivityFilter, string> = { all: 'todos', edit: '✎ edição', action: '▶ ação', read: '· leitura', critical: '⚠' }
const REQUEST_TEXT_MAX = 28

function knownFilter(value: string): ActivityFilter {
  return (FILTERS as readonly string[]).includes(value) ? (value as ActivityFilter) : 'all'
}

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

// $.ui.open vem antes de qualquer await: só uma abertura feita direto no clique conta como pedida
// pela pessoa; depois de esperar, o engine a trata como espontânea e não a mostra abaixo de 144 colunas.
async function openPane($: Engine, target: PaneTarget): Promise<void> {
  const opened = $.ui.open({ id: PANE, title: 'Painel', focus: true, columns: FULL_COLUMNS })
  await update($, paneMode, () => 'full')
  await update($, tab, () => target.tab)
  if (target.filter) await update($, filter, () => target.filter!)
  if (target.expand) {
    const entry = (await read($, activity)).find(one => one.id === target.expand)
    if (entry && !matchesFilter(entry, await read($, filter))) await update($, filter, () => 'all')
    await update($, expanded, () => target.expand!)
  }
  await update($, unseenCritical, () => [])
  await update($, sideListDismissed, () => false)
  const placed = await opened
  await update($, sideListShown, () => placed.isPlaced)
  if (!placed.isPlaced) $.ui.toast(`Painel não abriu: ${placed.reason}`)
}

/** A lista estreita à direita. Aberta sem clique, o engine só a mostra com 144 colunas ou mais. */
async function openSideList($: Engine): Promise<void> {
  const opened = $.ui.open({ id: PANE, title: 'Atividade', columns: COMPACT_COLUMNS, rows: INLINE_ROWS })
  await update($, paneMode, () => 'compact')
  const placed = await opened
  await update($, sideListShown, () => placed.isPlaced)
}

/** Mantém a lista lateral de pé: reabre se sumiu, a menos que a pessoa a tenha fechado no ×. */
async function ensureSideList($: Engine): Promise<void> {
  if (await read($, sideListDismissed)) return
  const pane = (await $.ui.panes()).find(open => open.id === PANE)
  if (pane) {
    await update($, sideListShown, () => pane.isPlaced)
    return
  }
  await openSideList($)
}

function recordTask(list: Task[], id: string, change: Partial<Task>): Task[] {
  const exists = list.some(task => task.id === id)
  if (!exists) return [...list, { id, subject: change.subject ?? id, status: change.status ?? 'pending' }]
  return list.map(task => (task.id === id ? { ...task, ...change } : task))
}

let homeDir: string | undefined
let lastBranch: string | undefined
let ticker: { cancel: () => void } | undefined

/** Refaz o registro de arquivos a partir do histórico da sessão: cobre o que veio antes desta carga do mod. */
async function backfillFileLog($: Engine): Promise<void> {
  const messages = await $.session.messages().catch(() => [])
  const startedAtById = new Map((await read($, activity)).map(entry => [entry.id, entry.startedAt]))
  const events = messages
    .flatMap(message => message.toolUses ?? [])
    .filter(use => !use.isError)
    .flatMap(use =>
      changesFromResult(use.tool, use.input, use.result).map(change => {
        const at = startedAtById.get(use.tool_use_id)
        return { ...change, id: use.tool_use_id, ...(at !== undefined ? { at } : {}) }
      }),
    )
  await update($, fileLog, log => mergeFileEvents(events, log))
}

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
    homeDir = await $.env.get('HOME').catch(() => undefined)
    await backfillFileLog($).catch(() => undefined)
    const figures = await $.session.usage()
    await update($, startedAt, () => figures.startedAt)
    await update($, now, () => Date.now())
    await refreshUsage($)
    await syncGit($)
    $.clock.every(GIT_EVERY_MS, () => void syncGit($))
    $.clock.every(PR_EVERY_MS, () => void refreshPr($))
    $.clock.every(60_000, () => void update($, now, () => Date.now()))
    await ensureSideList($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, sideListShown, () => false)
      if (e.origin.kind === 'person') await update($, sideListDismissed, () => true)
    }
    return next(e)
  })

  on('command.run', { command: 'painel' }, async $ => {
    await openPane($, { tab: 'activity' })
    return { text: 'Painel aberto.' }
  })

  on('session.measure', async ($, e, next) => {
    await refreshUsage($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const text = e.text.trim()
    if (text && !text.startsWith('/')) {
      const request: RequestGroup = { id: `req-${Date.now()}`, text: text.split('\n')[0]!, startedAt: Date.now() }
      await update($, requests, list => [...list, request].slice(-MAX_ACTIVITY))
      await update($, toggledGroups, () => [])
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await ensureSideList($)
    await update($, turns, count => count + 1)
    await update($, now, () => Date.now())
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const classified = classifyToolCall(String(e.tool), input)
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const started = Date.now()
    const isTracked = !isBookkeeping(String(e.tool))

    if (isTracked) {
      const groupId = (await read($, requests)).at(-1)?.id ?? 'inicio'
      await update($, activity, list =>
        [...list, { id, startedAt: started, status: 'running' as const, groupId, ...classified }].slice(-MAX_ACTIVITY),
      )
      await update($, now, () => started)
      ensureTicker($)
    }

    const ran = await next(e)

    if (isTracked) {
      const isError = ran.deny !== undefined || ran.isError === true
      const changes = isError ? [] : changesFromResult(String(e.tool), input, ran.result)
      const note = gitNote((ran.result as { gitOperation?: GitOperation } | undefined)?.gitOperation)
      const fromResult = {
        ...(changes.length > 0 ? { file: undefined, files: changes, stat: changesStat(changes) } : {}),
        ...(changes.length > 0 && e.tool === 'Bash' ? { category: 'edit' as const } : {}),
        ...(note ? { gitNote: note } : {}),
      }
      if (changes.length > 0) {
        await update($, fileLog, log => mergeFileEvents(log, changes.map(change => ({ ...change, id, at: started }))))
      }
      const output = cleanText(ran.deny ?? ran.text ?? '').slice(0, MAX_OUTPUT_CHARS)
      await update($, activity, list =>
        list.map(entry =>
          entry.id === id
            ? {
                ...entry,
                status: isError ? ('error' as const) : ('ok' as const),
                ms: Date.now() - started,
                output,
                category: settleCategory(classified.category, ran.isReadOnly === true),
                ...fromResult,
              }
            : entry,
        ),
      )
      if (classified.kind === 'critical') {
        await update($, unseenCritical, ids => [...ids, id])
      }
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

  // As chamadas de ferramenta saem da conversa: ficam só na lista lateral, e a tecla t as traz de volta.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (await read($, toolsInChat)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (await read($, toolsInChat)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, toolsInChat))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (await read($, toolsInChat)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns - 1
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
      <Box gap={2} paddingLeft={1}>
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

    const isReadsShown = await read($, showReads)
    const items = activityItems(
      (await read($, activity)).filter(entry => isReadsShown || categoryOf(entry) !== 'read'),
      await read($, unseenCritical),
      Math.max(0, width - ACTIVITY_HOTKEY_WIDTH),
      currentTime,
    )

    const activityLine = (
      <Box columnGap={3} paddingLeft={1}>
        {items.map(item => (
          <Box key={`item-${item.activity.id}`}>
            {renderPiece(item.icon, `icon-${item.activity.id}`)}
            <Text> </Text>
            <Button
              key={`open-${item.activity.id}`}
              plain
              dimColor={categoryOf(item.activity) === 'read' && item.activity.status === 'ok' ? true : undefined}
              label={item.label}
              onPress={() => void openPane($, { tab: 'activity', expand: item.activity.id })}
            />
            {item.suffix && renderPiece(item.suffix, `suffix-${item.activity.id}`)}
          </Box>
        ))}
        <Button key="open-activity" plain hotkey="a" label="atividade" onPress={() => void openPane($, { tab: 'activity' })} />
      </Box>
    )

    const below = await next(e)
    const isSideListShown = await read($, sideListShown)
    return (
      <Box flexDirection="column">
        {statusLine}
        {!isSideListShown && activityLine}
        {below}
      </Box>
    )
  })

  // Um erro no desenho deixaria o painel em branco; aqui ele aparece na tela, com o que falhou.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
    const kit = { Box, Text, Button, Code, Markdown }
    const width = Math.max(30, e.props.bodyColumns - 1)
    const list = await read($, activity)
    const taskList = await read($, tasks)
    const expandedId = await read($, expanded)
    const isFullOutput = await read($, showFullOutput)
    const currentFilter = knownFilter(await read($, filter))
    const isReadsShown = await read($, showReads)
    const currentTime = (await read($, now)) || Date.now()
    const rule = <Text dimColor>{'─'.repeat(width)}</Text>
    const isCompact = (await read($, paneMode)) === 'compact'
    const changedFiles = filesChanged(await read($, fileLog))

    const toggleExpanded = (id: string) =>
      void (async () => {
        await update($, showFullOutput, () => false)
        await update($, expanded, current => (current === id ? null : id))
      })()

    const detailFor = (entry: Activity, detailWidth: number) =>
      entryDetail(kit, entry, {
        width: detailWidth,
        previewLines: isCompact ? COMPACT_PREVIEW_LINES : OUTPUT_PREVIEW_LINES,
        isFull: isFullOutput,
        home: homeDir,
        isNarrow: isCompact,
        onShowAll: () =>
          void (isCompact ? openPane($, { tab: 'activity', expand: entry.id }) : update($, showFullOutput, () => true)),
      })

    const entryRow = (entry: Activity, count: number, labelRoom: number) => {
      const icon = iconFor(entry)
      const isOpen = entry.id === expandedId
      const isRunning = entry.status === 'running'
      const note = [entry.stat, entry.gitNote].filter(Boolean).join(' · ')
      const tail = isRunning ? ` ${duration(currentTime - entry.startedAt)}` : `${note ? ` ${note}` : ''}${repeatSuffix(count)}`
      return (
        <Box key={`row-${entry.id}`} flexDirection="column">
          <Box>
            <Text {...TONE_STYLE[icon.tone ?? 'normal']} bold={icon.bold}>
              {isOpen ? '▾' : icon.text}{' '}
            </Text>
            <Button
              key={`open-${entry.id}`}
              plain
              dimColor={categoryOf(entry) === 'read' && entry.status !== 'error' && !isOpen ? true : undefined}
              label={truncate(cleanText(entry.label), Math.max(4, labelRoom - tail.length))}
              onPress={() => toggleExpanded(entry.id)}
            />
            {tail && coloredStat(kit, `tail-${entry.id}`, tail)}
          </Box>
          {isOpen && <Box paddingLeft={2}>{detailFor(entry, labelRoom)}</Box>}
        </Box>
      )
    }

    const counts = countCategories(list)
    const criticalCount = list.filter(entry => entry.kind === 'critical').length
    const filterButton = (kind: ActivityFilter, total: number) => (
      <Button
        key={`filter-${kind}`}
        plain
        dimColor={currentFilter !== kind ? true : undefined}
        label={`${FILTER_LABEL[kind]} ${total}`}
        onPress={() => void update($, filter, current => (current === kind ? 'all' : kind))}
      />
    )
    const filters = (
      <Box gap={2}>
        {filterButton('edit', counts.edit)}
        {filterButton('action', counts.action)}
        <Button
          key="reads-toggle"
          plain
          dimColor={!isReadsShown ? true : undefined}
          label={`leitura ${isReadsShown ? '●' : '○'}`}
          onPress={() => void update($, showReads, shown => !shown)}
        />
        {criticalCount > 0 && filterButton('critical', criticalCount)}
      </Box>
    )

    if (isCompact) {
      const isToolsInChat = await read($, toolsInChat)
      const openTasks = taskList.filter(task => task.status !== 'completed')
      const shownTasks = openTasks.slice(0, COMPACT_TASKS)
      const toggled = await read($, toggledGroups)
      const readsOpen = await read($, readsOpenIn)
      const views = groupByRequest(list, await read($, requests))

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>Atividade</Text>
            <Box gap={2}>
              <Button
                key="tools-in-chat"
                plain
                hotkey="t"
                dimColor
                label={isToolsInChat ? 'tirar do chat' : 'ver no chat'}
                onPress={() => void update($, toolsInChat, shown => !shown)}
              />
              {changedFiles.length > 0 && (
                <Button
                  key="files"
                  plain
                  hotkey="f"
                  dimColor
                  label={`arquivos ${changedFiles.length}`}
                  onPress={() => void openPane($, { tab: 'files' })}
                />
              )}
              <Button key="expand" plain hotkey="a" label="abrir" onPress={() => void openPane($, { tab: 'activity' })} />
            </Box>
          </Box>
          {filters}
          {rule}
          {taskList.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>
                Tarefas {taskList.length - openTasks.length}/{taskList.length}
              </Text>
              {shownTasks.map(task => (
                <Text key={`ctask-${task.id}`} color={task.status === 'in_progress' ? 'warning' : undefined} dimColor={task.status === 'pending'}>
                  {task.status === 'in_progress' ? '◐' : '○'} {truncate(task.subject, width - 2)}
                </Text>
              ))}
              {rule}
            </Box>
          )}
          {views.length === 0 && <Text dimColor>Nada por aqui ainda.</Text>}
          {views.map((view, index) => {
            const id = view.request.id
            const isOpen = (index === 0) !== toggled.includes(id)
            const areReadsOpen = isReadsShown || readsOpen.includes(id) || currentFilter === 'read'
            const matching = view.entries.filter(entry => matchesFilter(entry, currentFilter))
            const visible = matching.filter(entry => areReadsOpen || categoryOf(entry) !== 'read')
            const hiddenReads = matching.length - visible.length
            const summary = countsLabel(view.counts)
            const since = sinceLabel(currentTime - view.request.startedAt)
            const title = `"${truncate(view.request.text, REQUEST_TEXT_MAX)}"`
            return (
              <Box key={`group-${id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
                <Box justifyContent="space-between">
                  <Button
                    key={`group-toggle-${id}`}
                    plain
                    dimColor={!isOpen ? true : undefined}
                    label={`${isOpen ? '▾' : '▸'} ${title}${summary ? ` · ${summary}` : ''}`}
                    onPress={() => void update($, toggledGroups, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))}
                  />
                  <Text dimColor>{since}</Text>
                </Box>
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={2}>
                    {groupRepeats(visible).map(({ activity: entry, count }) => entryRow(entry, count, width - 4))}
                    {hiddenReads > 0 && (
                      <Button
                        key={`reads-${id}`}
                        plain
                        dimColor
                        label={`· ${readsLabel(hiddenReads)}`}
                        onPress={() => void update($, readsOpenIn, ids => [...ids, id])}
                      />
                    )}
                    {visible.length === 0 && hiddenReads === 0 && <Text dimColor>nada neste filtro</Text>}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    const currentTab = await read($, tab)
    const tabs = (
      <Box gap={3}>
        <Button key="compact" plain hotkey="c" dimColor label="◂ compactar" onPress={() => void openSideList($)} />
        <Button key="tab-activity" plain hotkey="1" dimColor={currentTab !== 'activity' ? true : undefined} label={`Atividade ${list.length}`} onPress={() => void update($, tab, () => 'activity')} />
        <Button key="tab-tasks" plain hotkey="2" dimColor={currentTab !== 'tasks' ? true : undefined} label={`Tarefas ${taskList.length}`} onPress={() => void update($, tab, () => 'tasks')} />
        <Button key="tab-files" plain hotkey="3" dimColor={currentTab !== 'files' ? true : undefined} label={`Arquivos ${changedFiles.length}`} onPress={() => void update($, tab, () => 'files')} />
      </Box>
    )

    if (currentTab === 'files') {
      const added = changedFiles.reduce((sum, file) => sum + file.added, 0)
      const removed = changedFiles.reduce((sum, file) => sum + file.removed, 0)
      return (
        <Box flexDirection="column">
          {tabs}
          {changedFiles.length > 0 && (
            <Text>
              <Text dimColor>
                {changedFiles.length} {changedFiles.length === 1 ? 'arquivo' : 'arquivos'} nesta sessão ·{' '}
              </Text>
              {coloredStat(kit, 'files-total', `+${added} −${removed}`)}
            </Text>
          )}
          {rule}
          {changedFiles.length === 0 && <Text dimColor>Nenhum arquivo editado nesta sessão.</Text>}
          {changedFiles.map(file => {
            const key = `file:${file.path}`
            const isOpen = expandedId === key
            const stat = `${file.isWritten && file.removed === 0 ? 'novo · ' : ''}+${file.added} −${file.removed}`
            const shown = homePath(file.path, homeDir)
            return (
              <Box key={`file-${file.path}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
                <Box justifyContent="space-between">
                  <Box>
                    <Text color="warning">{isOpen ? '▾' : '✎'} </Text>
                    <Button
                      key={`file-open-${file.path}`}
                      plain
                      label={truncate(shown, Math.max(10, width - stat.length - 12))}
                      onPress={() => toggleExpanded(key)}
                    />
                  </Box>
                  {coloredStat(kit, `file-stat-${file.path}`, `${stat}  ${file.changes.length}×`)}
                </Box>
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={2}>
                    {file.changes.map((change, index) => (
                      <Box key={`file-change-${change.id}-${index}`} flexDirection="column">
                        <Text dimColor>── {change.at ? clockTime(change.at) : 'antes'} ──</Text>
                        {fileDiff(kit, `${change.id}-${index}`, change, {
                          width: width - 4,
                          previewLines: OUTPUT_PREVIEW_LINES,
                          isFull: isFullOutput,
                          home: homeDir,
                          onShowAll: () => void update($, showFullOutput, () => true),
                        })}
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    if (currentTab === 'tasks') {
      const glyph = { pending: '○', in_progress: '◐', completed: '●' } as const
      return (
        <Box flexDirection="column">
          {tabs}
          {rule}
          {taskList.length === 0 && <Text dimColor>Nenhuma tarefa nesta sessão.</Text>}
          {taskList.map(task => (
            <Text key={`task-${task.id}`} dimColor={task.status === 'completed'} color={task.status === 'in_progress' ? 'warning' : undefined}>
              {glyph[task.status]} {truncate(task.subject, width - 2)}
            </Text>
          ))}
        </Box>
      )
    }

    const TIME_COL = 6
    const rows = [...list]
      .reverse()
      .filter(entry => matchesFilter(entry, currentFilter))
      .filter(entry => isReadsShown || currentFilter === 'read' || categoryOf(entry) !== 'read' || entry.id === expandedId)

    return (
      <Box flexDirection="column">
        {tabs}
        {filters}
        {rule}
        {rows.length === 0 && <Text dimColor>Nada por aqui ainda.</Text>}
        {rows.map((entry, index) => {
          const time = clockTime(entry.startedAt)
          const showTime = index === 0 || clockTime(rows[index - 1]!.startedAt) !== time
          const elapsed = entry.status === 'running' ? currentTime - entry.startedAt : entry.ms
          return (
            <Box key={`full-${entry.id}`}>
              <Text dimColor>{(showTime ? time : '').padEnd(TIME_COL)}</Text>
              <Box flexDirection="column" flexGrow={1}>
                {entryRow(entry, 1, width - TIME_COL - 8)}
              </Box>
              <Text dimColor>{(elapsed === undefined ? '' : duration(elapsed)).padStart(6)}</Text>
            </Box>
          )
        })}
      </Box>
    )
    } catch (error) {
      const { Box, Text } = $.ui.resolve(e)
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      return (
        <Box flexDirection="column">
          <Text color="error" bold>
            painel: o desenho falhou
          </Text>
          <Text color="error">{message.slice(0, 2000)}</Text>
        </Box>
      )
    }
  })
}
