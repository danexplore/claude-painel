import { readMcpOutput, type McpOutput } from './mcp-view'

export type Tone = 'error' | 'warning' | 'success' | 'dim'

export type Piece = { text: string; tone?: Tone }

export type ShellOutput =
  | { kind: 'empty' }
  | { kind: 'data'; parsed: Extract<McpOutput, { kind: 'rows' | 'object' | 'json' }> }
  | { kind: 'diff'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'lines'; lines: Piece[][] }

const HEREDOC = /<<-?\s*['"]?\w+/
const OPEN_BRACKETS = new Set(['(', '{'])
const CLOSE_BRACKETS = new Set([')', '}'])

/**
 * O comando em uma linha por etapa, com o operador (`&&`, `||`, `|`, `;`) no começo de cada uma:
 * uma corrente de dez comandos vira dez linhas legíveis. Aspas, parênteses e heredoc não são quebrados.
 */
export function splitCommand(command: string): string[] {
  const text = command.trim()
  if (HEREDOC.test(text)) return text.split('\n')
  const segments: string[] = []
  let current = ''
  let operator = ''
  let quote: string | null = null
  let depth = 0
  const flush = () => {
    const body = current.trim()
    if (body) segments.push(operator ? `${operator} ${body}` : body)
    current = ''
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote) {
      current += char
      if (char === '\\' && quote === '"') current += text[++index] ?? ''
      else if (char === quote) quote = null
      continue
    }
    if (char === '\\') {
      current += char + (text[++index] ?? '')
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (OPEN_BRACKETS.has(char)) depth++
    if (CLOSE_BRACKETS.has(char)) depth = Math.max(0, depth - 1)
    if (depth === 0) {
      const pair = text.slice(index, index + 2)
      if (pair === '&&' || pair === '||') {
        flush()
        operator = pair
        index++
        continue
      }
      if (char === '|' || char === ';') {
        flush()
        operator = char
        continue
      }
      if (char === '\n') {
        flush()
        operator = ''
        continue
      }
    }
    current += char
  }
  flush()
  return segments
}

const HASH = '[0-9a-f]{7,40}'
const GIT_HISTORY = /\bgit\b.*\b(?:log|show|reflog|blame|cherry|shortlog)\b/
const GIT_STATUS_SHORT = /\bgit\b.*\bstatus\b.*(?:\s-s\b|--short|--porcelain)/
const STATUS_LINE = /^([ MADRCUT?!]{2}) (\S.*)$/

function statusTone(code: string): Tone {
  if (code.includes('D')) return 'error'
  if (code.includes('A') || code.includes('?')) return 'success'
  return 'warning'
}

/** Um trecho do dia a dia do git (push, status, log, branch) colorido pelo que significa: erro, aviso, ok, ruído. */
export function linePieces(command: string, line: string): Piece[] {
  if (/^\s*remote:/.test(line)) return [{ text: line, tone: 'dim' }]
  if (/^(?:error|fatal):|^\s*! \[|\berror:/i.test(line)) return [{ text: line, tone: 'error' }]
  if (/^warning:/i.test(line)) return [{ text: line, tone: 'warning' }]
  if (/^\s*\* \[new (?:branch|tag)\]/.test(line)) return [{ text: line, tone: 'success' }]
  if (new RegExp(`^\\s*\\+ ${HASH}\\.\\.\\.${HASH}\\s`).test(line)) return [{ text: line, tone: 'warning' }]
  if (new RegExp(`^\\s+${HASH}\\.\\.${HASH}\\s`).test(line)) return [{ text: line, tone: 'success' }]
  if (/^\s+(?:modified|both modified|renamed):/.test(line)) return [{ text: line, tone: 'warning' }]
  if (/^\s+new file:/.test(line)) return [{ text: line, tone: 'success' }]
  if (/^\s+deleted:/.test(line)) return [{ text: line, tone: 'error' }]
  if (/^(?:On branch|Your branch|Changes |Untracked files|nothing to commit)/.test(line)) return [{ text: line, tone: 'dim' }]
  if (GIT_STATUS_SHORT.test(command)) {
    const status = STATUS_LINE.exec(line)
    if (status) return [{ text: status[1]!, tone: statusTone(status[1]!) }, { text: ` ${status[2]}` }]
  }
  if (GIT_HISTORY.test(command)) {
    if (new RegExp(`^commit ${HASH}`).test(line)) return [{ text: line, tone: 'warning' }]
    if (/^(?:Author|Date|Merge):/.test(line)) return [{ text: line, tone: 'dim' }]
    const oneline = new RegExp(`^(${HASH}) (.*)$`).exec(line)
    if (oneline) return [{ text: oneline[1]!, tone: 'warning' }, { text: ` ${oneline[2]}` }]
  }
  if (/\bgit\b.*\bbranch\b/.test(command) && line.startsWith('* ')) return [{ text: line, tone: 'success' }]
  return [{ text: line }]
}

const STATUS_WORDS: Record<string, Tone> = {
  pass: 'success',
  passed: 'success',
  success: 'success',
  completed: 'success',
  fail: 'error',
  failed: 'error',
  failure: 'error',
  cancelled: 'warning',
  skipping: 'dim',
  skipped: 'dim',
  pending: 'warning',
  queued: 'warning',
  in_progress: 'warning',
}

/** Na saída em colunas do `gh` (checks, runs), a palavra de estado ganha a cor dela. */
export function cellTone(cell: string): Tone | undefined {
  return STATUS_WORDS[cell.trim().toLowerCase()]
}

function tabRows(lines: string[]): string[][] | null {
  if (lines.length === 0 || !lines.every(line => line.includes('\t'))) return null
  const rows = lines.map(line => line.split('\t'))
  const width = rows[0]!.length
  return width >= 2 && rows.every(row => row.length === width) ? rows : null
}

export function readShellOutput(command: string, output: string): ShellOutput {
  const text = output.replace(/\s+$/, '')
  if (!text.trim()) return { kind: 'empty' }
  if (/^[{[]/.test(text.trimStart())) {
    const parsed = readMcpOutput(text, false)
    if (parsed.kind === 'rows' || parsed.kind === 'object' || parsed.kind === 'json') return { kind: 'data', parsed }
  }
  if (/^diff --git/m.test(text)) return { kind: 'diff', text }
  const lines = text.split('\n')
  const rows = tabRows(lines)
  if (rows) return { kind: 'table', rows }
  return { kind: 'lines', lines: lines.map(line => linePieces(command, line)) }
}
