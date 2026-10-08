import type { ActivityKind } from '../../types'

export type Classified = { kind: ActivityKind; label: string; detail: string }

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

const BOOKKEEPING_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

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

export function classifyToolCall(tool: string, input: Record<string, unknown>): Classified {
  if (tool === 'Bash') {
    const command = stringField(input, 'command') ?? ''
    return { kind: classifyShell(command), label: shellLabel(command), detail: command }
  }

  const mcp = parseMcpTool(tool)
  if (mcp) {
    const sql = stringField(input, 'query')
    const isCritical = CRITICAL_MCP_TOOL.test(mcp.name) || (sql !== undefined && isCriticalSql(sql))
    return {
      kind: isCritical ? 'critical' : 'mcp',
      label: `${mcp.server} · ${mcp.name}`,
      detail: sql ?? JSON.stringify(input, null, 2),
    }
  }

  const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path')
  const target =
    (path && basename(path)) ??
    stringField(input, 'pattern') ??
    stringField(input, 'description') ??
    stringField(input, 'url') ??
    ''
  return {
    kind: 'plain',
    label: target ? `${tool} ${oneLine(target)}` : tool,
    detail: path ?? JSON.stringify(input, null, 2),
  }
}
