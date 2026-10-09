import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityFilter, FileEvent, GitInfo, ChatTools, PaneTab, PrInfo, RequestGroup, SubAgent, Task, TaskStatus, UsageInfo } from '../types'
import { agentIdFromOutput, changesFromResult, classifyToolCall, gitNote, isBookkeeping, settleCategory, type GitOperation } from './lib/classify'
import { cleanText, clockTime, duration, truncate } from './lib/format'
import {
  activityItems,
  categoryOf,
  countCategories,
  countsLabel,
  isHiddenRead,
  currentWork,
  compactWorkLabel,
  maskedCount,
  groupByRequest,
  iconFor,
  readsLabel,
  sinceLabel,
  fitSegments,
  arrangeWithAgents,
  groupRepeats,
  runningAgents,
  type AgentRow,
  repeatSuffix,
  matchesFilter,
  statusSegments,
  type PaneTarget,
  type Piece,
  type Tone,
} from './lib/layout'
import { parseGitStatus, parsePrView } from './lib/parse'
import { changesStat, filesChanged, groupByProject, mergeFileEvents, projectPath, projectRootOf } from './lib/files'
import { coloredStat, entryDetail, fileDiff } from './views/detail'

const PANE = 'painel'
const MAX_ACTIVITY = 200
const MAX_OUTPUT_CHARS = 20_000
/** Resultado de MCP (linhas de uma query) costuma ser maior e só vale inteiro. */
const MAX_MCP_OUTPUT_CHARS = 120_000
const GIT_EVERY_MS = 10_000
const PR_EVERY_MS = 60_000
const TICK_MS = 1_000
const ACTIVITY_HOTKEY_WIDTH = 'a: atividade'.length + 4
const COMPACT_COLUMNS = 42
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
const sideListShown = atom({ plugin: 'painel', key: 'sideListShown' } as const, false)
const sideListDismissed = atom({ plugin: 'painel', key: 'sideListDismissed' } as const, false)
const agents = atom({ plugin: 'painel', key: 'agents' } as const, [] as SubAgent[])
const chatTools = atom({ plugin: 'painel', key: 'chatTools' } as const, 'none' as ChatTools)
const CHAT_TOOLS_NEXT: Record<ChatTools, ChatTools> = { none: 'edits', edits: 'all', all: 'none' }
const CHAT_TOOLS_LABEL: Record<ChatTools, string> = { none: 'chat: nada', edits: 'chat: edições', all: 'chat: tudo' }
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])

/**
 * O que aparece na conversa: nada, só o que mudou arquivo, ou tudo como o Claude Code mostra.
 * "Mudou arquivo" vale para Edit/Write e para o Bash que mexeu em arquivo (`sed -i`, `python`…),
 * conferido no registro da atividade pelo id da chamada.
 */
async function changesAFile($: Engine, call: { tool: string; tool_use_id?: string }): Promise<boolean> {
  if (EDIT_TOOLS.has(call.tool)) return true
  if (!call.tool_use_id) return false
  const entry = (await read($, activity)).find(one => one.id === call.tool_use_id)
  return entry !== undefined && categoryOf(entry) === 'edit'
}

async function showsInChat($: Engine, call: { tool: string; tool_use_id?: string }): Promise<boolean> {
  const mode = await read($, chatTools)
  if (mode === 'all') return true
  return mode === 'edits' && (await changesAFile($, call))
}
const fileLog = atom({ plugin: 'painel', key: 'fileLog' } as const, [] as FileEvent[])
const projectRoots = atom({ plugin: 'painel', key: 'projectRoots' } as const, [] as string[])
const requests = atom({ plugin: 'painel', key: 'requests' } as const, [] as RequestGroup[])
const veilMasked = atom({ plugin: 'painel', key: 'veilMasked' } as const, 0)
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
  const opened = $.ui.open({ id: PANE, title: 'Atividade', columns: COMPACT_COLUMNS, rows: INLINE_ROWS })
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
  const placed = await opened
  await update($, sideListShown, () => placed.isPlaced)
}

/** Recolhe a lista; ela não reabre sozinha até a pessoa clicar em `a: atividade` na faixa. */
async function collapseSideList($: Engine): Promise<void> {
  await update($, sideListDismissed, () => true)
  await update($, sideListShown, () => false)
  await $.ui.close({ id: PANE })
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

type AgentCall = { id: string; started: number; input: Record<string, unknown>; output: string }

/**
 * Liga a chamada Agent ao subagente mesmo que o agent.spawn não tenha passado por aqui
 * (mod recarregado, versão do engine): o id vem no texto devolvido pela ferramenta.
 */
async function linkAgentCall($: Engine, call: AgentCall): Promise<void> {
  const agentId = agentIdFromOutput(call.output)
  if (!agentId) return
  const text = (key: string) => (typeof call.input[key] === 'string' ? (call.input[key] as string) : '')
  await update($, agents, list => {
    const known = list.find(agent => agent.id === agentId)
    if (known) return list.map(agent => (agent.id === agentId ? { ...agent, toolUseId: call.id } : agent))
    const agent: SubAgent = {
      id: agentId,
      toolUseId: call.id,
      description: text('description') || text('prompt').split('\n')[0]!.slice(0, 80),
      type: text('subagent_type') || 'general-purpose',
      startedAt: call.started,
      status: 'running',
    }
    return [...list, agent].slice(-MAX_ACTIVITY)
  })
}

function recordTask(list: Task[], id: string, change: Partial<Task>): Task[] {
  const exists = list.some(task => task.id === id)
  if (!exists) return [...list, { id, subject: change.subject ?? id, status: change.status ?? 'pending' }]
  return list.map(task => (task.id === id ? { ...task, ...change } : task))
}

let homeDir: string | undefined
/** Pastas já consultadas que não estão em repositório git, para não perguntar de novo. */
const dirsWithoutRepo = new Set<string>()

async function learnProjectRoots($: Engine, paths: string[]): Promise<void> {
  const known = [...(await read($, projectRoots))]
  for (const path of new Set(paths)) {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    if (projectRootOf(path, known) || dirsWithoutRepo.has(dir)) continue
    const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 }).catch(() => undefined)
    const root = top?.exitCode === 0 ? top.stdout.trim() : ''
    if (root && path.startsWith(`${root}/`)) known.push(root)
    else dirsWithoutRepo.add(dir)
  }
  await update($, projectRoots, current => (current.length === known.length ? current : known))
}
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
  await learnProjectRoots($, events.map(event => event.path))
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
      const isAgentRunning = (await read($, agents)).some(agent => agent.status === 'running')
      if (!isAgentRunning && !list.some(entry => entry.status === 'running')) {
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
    const loop = (e as { agentId?: string }).agentId
    if (loop) {
      await update($, agents, list => list.map(agent => (agent.id === loop ? { ...agent, status: 'done' as const, endedAt: Date.now() } : agent)))
      return next(e)
    }
    await ensureSideList($)
    await update($, turns, count => count + 1)
    await update($, now, () => Date.now())
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) {
      const agent: SubAgent = {
        id: spawned.agentId,
        toolUseId: e.tool_use_id,
        description: e.description || e.prompt.split('\n')[0]!.slice(0, 80),
        type: e.subagentType,
        startedAt: Date.now(),
        status: 'running',
      }
      await update($, agents, list => [...list.filter(one => one.id !== agent.id), agent].slice(-MAX_ACTIVITY))
      ensureTicker($)
    }
    return spawned
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
        [
          ...list,
          { id, startedAt: started, status: 'running' as const, groupId, tool: String(e.tool), ...classified, ...(e.agentId ? { agentId: e.agentId } : {}) },
        ].slice(-MAX_ACTIVITY),
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
        await learnProjectRoots($, changes.map(change => change.path))
      }
      const output = cleanText(ran.deny ?? ran.text ?? '').slice(0, classified.isMcp ? MAX_MCP_OUTPUT_CHARS : MAX_OUTPUT_CHARS)
      await update($, activity, list =>
        list.map(entry =>
          entry.id === id
            ? {
                ...entry,
                status: isError ? ('error' as const) : ('ok' as const),
                ms: Date.now() - started,
                output,
                category: AGENT_TOOLS.has(String(e.tool)) ? ('action' as const) : settleCategory(classified.category, ran.isReadOnly === true),
                ...fromResult,
              }
            : entry,
        ),
      )
      if (classified.kind === 'critical') {
        await update($, unseenCritical, ids => [...ids, id])
      }
      if (AGENT_TOOLS.has(String(e.tool)) && !isError) await linkAgentCall($, { id, started, input, output })
    }

    const handbackLoop = String(e.tool) === 'SubagentHandback' ? (e as { agentId?: string }).agentId : undefined
    if (handbackLoop) {
      const loop = handbackLoop
      await update($, agents, list => list.map(agent => (agent.id === loop ? { ...agent, status: 'done' as const, endedAt: Date.now() } : agent)))
    }

    // A lista de tarefas é a do loop principal: a de um subagente não substitui a sua.
    const created = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
    const isMainLoop = !e.agentId
    if (isMainLoop && e.tool === 'TaskCreate' && created) {
      await update($, tasks, list => recordTask(list, created.id, { subject: created.subject, status: 'pending' }))
    } else if (isMainLoop && e.tool === 'TaskUpdate' && e.status) {
      const status = e.status
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(task => task.id !== e.taskId)
          : recordTask(list, e.taskId, { status, ...(e.subject ? { subject: e.subject } : {}) }),
      )
    } else if (isMainLoop && e.tool === 'TodoWrite') {
      await update($, tasks, () =>
        e.todos.map((todo, index) => ({ id: `todo-${index}`, subject: todo.content, status: todo.status as TaskStatus })),
      )
    }

    if (GIT_TOUCHING_TOOLS.has(String(e.tool))) void syncGit($)

    return ran
  }).catch(($, e, next) => next(e))

  // As chamadas de ferramenta saem da conversa: ficam só na lista lateral, e a tecla t as traz de volta.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (await showsInChat($, e.props)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (await showsInChat($, e.props)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, chatTools)) === 'all') return next(e)
    // Em modo edições, um grupo com alguma edição abre em linhas: cada chamada passa pelo filtro do
    // ToolUse sozinha, e só as edições aparecem. Grupo sem edição some inteiro.
    if ((await read($, chatTools)) === 'edits' && (await Promise.all(e.props.calls.map(call => changesAFile($, call)))).some(Boolean)) {
      return next({ ...e, props: { ...e.props, isExpanded: true } })
    }
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if ((await read($, chatTools)) === 'all') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // O rodapé do secrets-veil vira um `◈ N` na faixa: a máscara segue igual, só a linha própria sai.
  on('ui.status', async ($, e, next) => {
    if (!next.origin.plugin.includes('secrets-veil')) return next(e)
    const count = maskedCount(e.text)
    if (count === undefined) return next(e)
    await update($, veilMasked, () => count)
    return { value: undefined }
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
        masked: await read($, veilMasked),
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

    const work = currentWork(await read($, activity), await read($, requests))
    const agentsRunning = runningAgents(await read($, agents))
    const isSideListShown = await read($, sideListShown)
    const counter = work ? compactWorkLabel(work, agentsRunning) : ''
    const counterWidth = counter ? counter.length + 5 : 0
    const isReadsShown = await read($, showReads)
    // Com a lista lateral aberta os comandos já estão nela: fica só o que está rodando agora.
    const items = activityItems(
      (await read($, activity)).filter(entry => (isReadsShown || !isHiddenRead(entry)) && (!isSideListShown || entry.status === 'running')),
      isSideListShown ? [] : await read($, unseenCritical),
      Math.max(0, width - ACTIVITY_HOTKEY_WIDTH - counterWidth),
      currentTime,
    )

    const activityLine = (
      <Box columnGap={3} paddingLeft={1}>
        {work && (
          <Box key="work">
            <Text color={work.running ? 'warning' : undefined} dimColor={work.running ? undefined : true}>
              {work.running ? '◌ ' : '✓ '}
            </Text>
            <Button
              key="work-count"
              plain
              dimColor
              label={counter || 'nada ainda'}
              onPress={() => void openPane($, { tab: 'activity', ...(work.running ? { expand: work.running.id } : {}) })}
            />
            <Text dimColor> │</Text>
          </Box>
        )}
        {items.map(item => (
          <Box key={`item-${item.activity.id}`}>
            {renderPiece(item.icon, `icon-${item.activity.id}`)}
            <Text> </Text>
            <Button
              key={`open-${item.activity.id}`}
              plain
              dimColor={isHiddenRead(item.activity) && item.activity.status === 'ok' ? true : undefined}
              label={item.label}
              onPress={() => void openPane($, { tab: 'activity', expand: item.activity.id })}
            />
            {item.suffix && renderPiece(item.suffix, `suffix-${item.activity.id}`)}
          </Box>
        ))}
        {!isSideListShown && <Button key="open-activity" plain hotkey="a" label="atividade" onPress={() => void openPane($, { tab: 'activity' })} />}
      </Box>
    )

    const below = await next(e)
    return (
      <Box flexDirection="column">
        {statusLine}
        {(work || !isSideListShown) && activityLine}
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
    const changedFiles = filesChanged(await read($, fileLog))
    const roots = await read($, projectRoots)

    const toggleExpanded = (id: string) =>
      void (async () => {
        await update($, showFullOutput, () => false)
        await update($, expanded, current => (current === id ? null : id))
      })()

    const detailFor = (entry: Activity, detailWidth: number) =>
      entryDetail(kit, entry, {
        width: detailWidth,
        previewLines: COMPACT_PREVIEW_LINES,
        isFull: isFullOutput,
        home: homeDir,
        roots,
        isNarrow: true,
        onShowAll: () => void update($, showFullOutput, () => true),
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
              dimColor={isHiddenRead(entry) && entry.status !== 'error' && !isOpen ? true : undefined}
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
        {filterButton('all', list.length)}
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

    const currentTab = await read($, tab)
    const chatMode = await read($, chatTools)
    const openTasks = taskList.filter(task => task.status !== 'completed')
    const tabButton = (key: PaneTab, hotkey: string, label: string) => (
      <Button
        key={`tab-${key}`}
        plain
        hotkey={hotkey}
        dimColor={currentTab !== key ? true : undefined}
        label={label}
        onPress={() => void update($, tab, () => key)}
      />
    )
    const header = (
      <Box justifyContent="space-between">
        <Box gap={2}>
          <Button key="collapse" plain hotkey="r" dimColor label="«" onPress={() => void collapseSideList($)} />
          {tabButton('activity', '1', 'Atividade')}
          {tabButton('files', '2', `Arquivos ${changedFiles.length}`)}
          {taskList.length > 0 && tabButton('tasks', '3', `Tarefas ${taskList.length - openTasks.length}/${taskList.length}`)}
        </Box>
        <Button
          key="chat-tools"
          plain
          hotkey="t"
          dimColor={chatMode === 'none' ? true : undefined}
          label={CHAT_TOOLS_LABEL[chatMode]}
          onPress={() => void update($, chatTools, mode => CHAT_TOOLS_NEXT[mode])}
        />
      </Box>
    )

    if (currentTab === 'files') {
      const added = changedFiles.reduce((sum, file) => sum + file.added, 0)
      const removed = changedFiles.reduce((sum, file) => sum + file.removed, 0)
      return (
        <Box flexDirection="column">
          {header}
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
          {groupByProject(changedFiles, roots).map(group => {
            const groupAdded = group.files.reduce((sum, file) => sum + file.added, 0)
            const groupRemoved = group.files.reduce((sum, file) => sum + file.removed, 0)
            return (
              <Box key={`project-${group.root ?? 'none'}`} flexDirection="column" marginBottom={1}>
                <Box justifyContent="space-between">
                  <Text bold color={group.root ? 'claude' : undefined} dimColor={group.root ? undefined : true}>
                    {group.name}
                  </Text>
                  {coloredStat(kit, `project-stat-${group.root ?? 'none'}`, `+${groupAdded} −${groupRemoved}`)}
                </Box>
              {group.files.map(file => {
                const key = `file:${file.path}`
                const isOpen = expandedId === key
                const stat = `${file.isWritten && file.removed === 0 ? 'novo · ' : ''}+${file.added} −${file.removed}`
                const shown = projectPath(file.path, roots, homeDir)
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
                              previewLines: COMPACT_PREVIEW_LINES,
                              isNarrow: true,
                              isFull: isFullOutput,
                              home: homeDir,
                              roots,
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
          })}
        </Box>
      )
    }

    if (currentTab === 'tasks') {
      const glyph = { pending: '○', in_progress: '◐', completed: '●' } as const
      return (
        <Box flexDirection="column">
          {header}
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

    const shownTasks = openTasks.slice(0, COMPACT_TASKS)
    const toggled = await read($, toggledGroups)
    const readsOpen = await read($, readsOpenIn)
    const views = groupByRequest(list, await read($, requests))
    const agentList = await read($, agents)

    const agentBlock = (row: AgentRow, areReadsOpen: boolean, room: number) => {
      const { agent, call, children, counts: agentCounts } = row
      const key = `agent-${agent.id}`
      const isOpen = (agent.status === 'running') !== toggled.includes(key)
      const shown = children.filter(entry => areReadsOpen || !isHiddenRead(entry))
      const elapsed = (agent.endedAt ?? currentTime) - agent.startedAt
      const status = agent.status === 'running' ? `◌ ${duration(elapsed)}` : `✓ ${duration(elapsed)}`
      const summary = [countsLabel(agentCounts), agentCounts.read ? readsLabel(agentCounts.read) : ''].filter(Boolean).join(' · ')
      return (
        <Box key={key} flexDirection="column">
          <Box justifyContent="space-between">
            <Box>
              <Text color="suggestion">{isOpen ? '▾' : '◇'} </Text>
              <Button
                key={`${key}-toggle`}
                plain
                label={truncate(`${agent.type} · ${cleanText(agent.description)}`, Math.max(8, room - status.length - 3))}
                onPress={() => void update($, toggledGroups, ids => (ids.includes(key) ? ids.filter(one => one !== key) : [...ids, key]))}
              />
            </Box>
            <Text color={agent.status === 'running' ? 'warning' : undefined} dimColor={agent.status === 'running' ? undefined : true}>
              {status}
            </Text>
          </Box>
          {summary && <Text dimColor>{'  '}{truncate(summary, room - 2)}</Text>}
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {groupRepeats(shown).map(({ activity: entry, count }) => entryRow(entry, count, room - 2))}
              {call && call.status !== 'running' && entryRow({ ...call, label: 'resposta do agente', stat: undefined }, 1, room - 2)}
            </Box>
          )}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header}
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
          const visible = matching.filter(entry => areReadsOpen || !isHiddenRead(entry))
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
                  {arrangeWithAgents(matching, agentList).map(row =>
                    row.kind === 'agent'
                      ? agentBlock(row.row, areReadsOpen, width - 4)
                      : (areReadsOpen || !isHiddenRead(row.group.activity)) && entryRow(row.group.activity, row.group.count, width - 4),
                  )}
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
