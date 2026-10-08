import type { ActivityCategory, ActivityKind, FileChange } from '../../types'

export type Classified = {
  kind: ActivityKind
  category: ActivityCategory
  label: string
  detail: string
  stat?: string
  sql?: string
  isMcp?: true
  file?: FileChange
}

const CRITICAL_SHELL = [
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)/i,
  /\bgit\s+push\b[^\n]*(?:\s--force\b|\s-f\b|--force-with-lease)/,
  /\bgit\s+reset\b[^\n]*--hard\b/,
  /\bgit\s+clean\b[^\n]*\s-[a-z]*f/,
  /\bgit\s+branch\b[^\n]*\s-D\b/,
  /\bsupabase\s+db\s+push\b/,
  /\bsupabase\s+db\s+reset\b(?![^\n]*--local)/,
  /\bvercel\b[^\n]*--prod\b/,
  /(?:^|[^a-z0-9_-])(?:prod|production)(?:[^a-z0-9_]|$)/i,
]

const CRITICAL_SQL = [
  /\bdrop\s+(?:table|schema|database|view|materialized\s+view|function|index|type|policy|trigger|column|extension)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i,
  /\bupdate\s+[\w."]+\s+set\b(?![\s\S]*\bwhere\b)/i,
]

const CRITICAL_MCP_TOOL = /^(?:apply_migration|delete_|pause_project|merge_branch|reset_branch|rebase_branch)/

const INTEGRATION_PROGRAMS = new Set(['gh', 'vercel', 'supabase', 'pnpm', 'npm', 'npx', 'psql', 'curl'])

const GIT_REMOTE_VERBS = new Set(['push', 'pull', 'fetch'])

export function isCriticalSql(sql: string): boolean {
  return CRITICAL_SQL.some(rule => rule.test(sql))
}

export function stripRtk(command: string): string {
  return command.replace(/(^|&&|\|\||;|\|)(\s*)rtk\s+/g, '$1$2')
}

export function splitShellChain(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

function classifyShellSegment(segment: string): ActivityKind {
  const [program, verb] = segment.split(/\s+/)
  if (program === 'git' && GIT_REMOTE_VERBS.has(verb ?? '')) return 'cli'
  return INTEGRATION_PROGRAMS.has(program ?? '') ? 'cli' : 'plain'
}

const SQL_RUNNER = /^(?:psql|supabase\s+db)\b/

export function classifyShell(command: string): ActivityKind {
  const clean = stripRtk(command)
  const segments = splitShellChain(clean)
  const runsSql = segments.some(segment => SQL_RUNNER.test(segment))
  if (CRITICAL_SHELL.some(rule => rule.test(clean)) || (runsSql && isCriticalSql(clean))) return 'critical'
  return segments.some(segment => classifyShellSegment(segment) === 'cli') ? 'cli' : 'plain'
}

const READ_PROGRAMS = new Set([
  'cd', 'ls', 'cat', 'grep', 'rg', 'egrep', 'head', 'tail', 'wc', 'awk', 'cut', 'sort', 'uniq', 'tr', 'jq', 'pwd',
  'echo', 'printf', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'tree', 'less', 'diff', 'basename',
  'dirname', 'realpath', 'readlink', 'date', 'env', 'printenv', 'id', 'whoami', 'uname', 'test', '[', 'true', 'nl',
])
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'worktree', 'describe', 'tag'])
const WRITES_TO_FILE = /(?:^|[^>&2])>>?\s*(?!\/dev\/null|&)[\w~./"'-]/

function isReadSegment(segment: string): boolean {
  const [program = '', verb = ''] = segment.split(/\s+/)
  if (program === 'sed') return !/(?:^|\s)-[a-z]*i/.test(segment)
  if (program === 'find') return !/\s-(?:delete|exec|execdir|ok)\b/.test(segment)
  if (program === 'git') return GIT_READ.has(verb)
  return READ_PROGRAMS.has(program)
}

/** Só leitura quando cada parte da chain é um programa que apenas consulta e nada é redirecionado para arquivo. */
export function isReadOnlyShell(command: string): boolean {
  const clean = stripRtk(command)
  if (WRITES_TO_FILE.test(clean) || /<<|\btee\b/.test(clean)) return false
  const segments = splitShellChain(clean.replace(/\d?>&\d|2>\/dev\/null|>\s*\/dev\/null/g, ''))
  return segments.length > 0 && segments.every(isReadSegment)
}

const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/

const LONG_PATH = /(?:~|\.{1,2})?\/(?:[^\s'"\/]+\/){2,}[^\s'"\/]*/g

/** `~/.claude/mods/painel/hooks/lib` vira `…/hooks/lib`: as duas últimas partes dizem o bastante. */
export function shortenPaths(text: string): string {
  return text.replace(LONG_PATH, path => {
    const parts = path.split('/').filter(Boolean)
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
  })
}

export function shellLabel(command: string): string {
  return shortenPaths(oneLine(stripRtk(command).replace(LEADING_CD, '')))
}

const BOOKKEEPING_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'SubagentHandback'])

/** Chamadas de bastidor do próprio Claude, que não dizem nada sobre o trabalho em si. */
export function isBookkeeping(tool: string): boolean {
  return BOOKKEEPING_TOOLS.has(tool) || tool.startsWith('mcp__plan-progress__')
}

function oneLine(text: string): string {
  return text.split('\n')[0]!.replace(/\s+/g, ' ').trim()
}

export function mcpServerName(raw: string): string {
  return raw.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '')
}

function parseMcpTool(tool: string): { server: string; name: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  return match ? { server: mcpServerName(match[1]!), name: match[2]! } : null
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function stringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' ? value : undefined
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'BashOutput'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const MCP_READ = /^(?:get|list|search|read|fetch|query_logs)_?/
const SHELL_EDIT = [/\bsed\s+(?:-[a-z]*\s+)*-i/, /\bperl\s+(?:-[a-z]*\s+)*-[a-z]*i/, /\btee\b/, /(?:^|[^>&2])>>?\s*(?!\/dev\/null|&)[\w~./"'-]/]

function lineCount(text: string | undefined): number {
  return text ? text.split('\n').length : 0
}

function editStat(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Edit') return `+${lineCount(stringField(input, 'new_string'))} −${lineCount(stringField(input, 'old_string'))}`
  if (tool === 'MultiEdit' && Array.isArray(input['edits'])) {
    const edits = input['edits'] as Record<string, unknown>[]
    const added = edits.reduce((sum, edit) => sum + lineCount(stringField(edit, 'new_string')), 0)
    const removed = edits.reduce((sum, edit) => sum + lineCount(stringField(edit, 'old_string')), 0)
    return `+${added} −${removed}`
  }
  if (tool === 'Write') return `${lineCount(stringField(input, 'content'))} linhas`
  return undefined
}

const MAX_FILE_CHARS = 20_000

function hunk(oldText: string, newText: string): string {
  const removed = oldText.split('\n')
  const added = newText.split('\n')
  return [
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
  ].join('\n')
}

/** O que a edição mudou, para mostrar ao expandir: o conteúdo escrito ou um diff de cada troca. */
function fileChange(tool: string, input: Record<string, unknown>, path: string): FileChange | undefined {
  if (tool === 'Write') return { path, content: (stringField(input, 'content') ?? '').slice(0, MAX_FILE_CHARS) }
  const edits =
    tool === 'MultiEdit' && Array.isArray(input['edits'])
      ? (input['edits'] as Record<string, unknown>[])
      : tool === 'Edit'
        ? [input]
        : []
  if (edits.length === 0) return undefined
  const diff = edits
    .map(edit => hunk(stringField(edit, 'old_string') ?? '', stringField(edit, 'new_string') ?? ''))
    .join('\n')
  return { path, diff: diff.slice(0, MAX_FILE_CHARS) }
}

export type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** O patch que o Edit/Write devolve, com número de linha real e contexto, como diff unificado. */
export function patchDiff(hunks: readonly PatchHunk[]): string {
  return hunks
    .map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n'))
    .join('\n')
}

export function patchStat(hunks: readonly PatchHunk[]): string {
  const lines = hunks.flatMap(hunk => hunk.lines)
  return `+${lines.filter(line => line.startsWith('+')).length} −${lines.filter(line => line.startsWith('-')).length}`
}

export type GitOperation = {
  commit?: { sha: string; kind: string; branch?: string }
  push?: { branch: string }
  branch?: { ref: string; action: string }
  pr?: { number: number; action: string }
}

const PR_ACTION: Record<string, string> = { created: 'aberto', merged: 'mesclado', edited: 'editado', commented: 'comentado', closed: 'fechado' }

/** Uma etiqueta curta do que o comando fez no git: commit, push, merge/rebase, PR. */
export function gitNote(operation: GitOperation | undefined): string | undefined {
  if (!operation) return undefined
  const parts = [
    operation.commit && `commit ${operation.commit.sha.slice(0, 7)}${operation.commit.branch ? ` · ${operation.commit.branch}` : ''}`,
    operation.push && `push ${operation.push.branch}`,
    operation.branch && `${operation.branch.action === 'merged' ? 'merge' : 'rebase'} ${operation.branch.ref}`,
    operation.pr && `PR #${operation.pr.number} ${PR_ACTION[operation.pr.action] ?? operation.pr.action}`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

type BashResult = { bashEditDiff?: { files: { filePath: string; hunks: PatchHunk[] }[] } }
type FileToolResult = { structuredPatch?: PatchHunk[]; type?: string; filePath?: string; content?: string }

/**
 * Os arquivos que uma chamada mudou, a partir do que a ferramenta devolveu: o patch do Edit/Write,
 * o conteúdo de um Write que criou o arquivo, ou o diff que o Claude Code anota num Bash.
 */
export function changesFromResult(tool: string, input: Record<string, unknown>, result: unknown): FileChange[] {
  const fromResult = changesInResult(tool, input, result)
  if (fromResult.length > 0) return fromResult
  const fromInput = classifyToolCall(tool, input).file
  return fromInput ? [fromInput] : []
}

function changesInResult(tool: string, input: Record<string, unknown>, result: unknown): FileChange[] {
  if (typeof result !== 'object' || result === null) return []
  if (tool === 'Bash') {
    return ((result as BashResult).bashEditDiff?.files ?? []).map(file => ({ path: file.filePath, diff: patchDiff(file.hunks) }))
  }
  if (!EDIT_TOOLS.has(tool)) return []
  const record = result as FileToolResult
  const path = record.filePath ?? stringField(input, 'file_path') ?? stringField(input, 'notebook_path')
  if (!path) return []
  if (record.structuredPatch && record.structuredPatch.length > 0) return [{ path, diff: patchDiff(record.structuredPatch) }]
  const content = record.content ?? stringField(input, 'content')
  return content !== undefined ? [{ path, content: content.slice(0, MAX_FILE_CHARS) }] : []
}

/** O tipo antes de rodar; um Bash que o Claude Code marcar como somente leitura vira leitura depois. */
export function settleCategory(category: ActivityCategory, isReadOnly: boolean): ActivityCategory {
  return category === 'action' && isReadOnly ? 'read' : category
}

export function classifyToolCall(tool: string, input: Record<string, unknown>): Classified {
  if (tool === 'Bash') {
    const command = stringField(input, 'command') ?? ''
    const description = stringField(input, 'description')
    const clean = stripRtk(command)
    return {
      kind: classifyShell(command),
      category: SHELL_EDIT.some(rule => rule.test(clean)) ? 'edit' : isReadOnlyShell(command) ? 'read' : 'action',
      label: description ? oneLine(description) : shellLabel(command),
      detail: command,
    }
  }

  const mcp = parseMcpTool(tool)
  if (mcp) {
    const sql = stringField(input, 'query')
    const isCritical = CRITICAL_MCP_TOOL.test(mcp.name) || (sql !== undefined && isCriticalSql(sql))
    return {
      kind: isCritical ? 'critical' : 'mcp',
      category: !isCritical && MCP_READ.test(mcp.name) ? 'read' : 'action',
      label: `${mcp.server} · ${mcp.name}`,
      detail: sql ?? JSON.stringify(input, null, 2),
      ...(sql !== undefined ? { sql } : {}),
      isMcp: true,
    }
  }

  const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path')
  const isEdit = EDIT_TOOLS.has(tool)
  const target =
    (path && basename(path)) ??
    stringField(input, 'description') ??
    stringField(input, 'pattern') ??
    stringField(input, 'url') ??
    stringField(input, 'query') ??
    ''
  const stat = editStat(tool, input)
  const file = isEdit && path ? fileChange(tool, input, path) : undefined
  return {
    kind: 'plain',
    category: isEdit ? 'edit' : READ_TOOLS.has(tool) ? 'read' : 'action',
    label: isEdit && path ? basename(path) : target ? `${tool} ${oneLine(target)}` : tool,
    detail: path ?? JSON.stringify(input, null, 2),
    ...(stat ? { stat } : {}),
    ...(file ? { file } : {}),
  }
}

const AGENT_ID_IN_OUTPUT = /agentId:\s*([\w-]+)/

/** A ferramenta Agent devolve o id do subagente no texto (`agentId: …`), mesmo quando roda em segundo plano. */
export function agentIdFromOutput(output: string): string | undefined {
  return AGENT_ID_IN_OUTPUT.exec(output)?.[1]
}
