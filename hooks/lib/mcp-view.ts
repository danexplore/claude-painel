export type Row = Record<string, unknown>

export type McpOutput =
  | { kind: 'rows'; rows: Row[] }
  | { kind: 'json'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'text'; text: string }

export const MAX_ROWS = 50
const COLUMN_GAP = 2
const UNTRUSTED = /<untrusted-data-[\w-]+>\s*([\s\S]*?)\s*<\/untrusted-data-[\w-]+>/

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isFlatRow(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(cell => cell === null || typeof cell !== 'object')
  )
}

function asRows(value: unknown): Row[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(isFlatRow) ? value : null
}

/** O Supabase embrulha o resultado num aviso; o que interessa está entre as tags `untrusted-data`. */
function unwrapEnvelope(value: unknown): unknown {
  const result = typeof value === 'object' && value !== null ? (value as Row)['result'] : undefined
  if (typeof result !== 'string') return value
  const inner = UNTRUSTED.exec(result)?.[1]
  return inner === undefined ? result : (parseJson(inner) ?? inner)
}

function errorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const error = (value as Row)['error']
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && typeof (error as Row)['message'] === 'string') {
    return (error as Row)['message'] as string
  }
  return null
}

export function readMcpOutput(output: string, isError: boolean): McpOutput {
  const parsed = parseJson(output.trim())
  if (parsed === undefined) return isError ? { kind: 'error', message: output } : { kind: 'text', text: output }
  const message = errorMessage(parsed)
  if (message !== null) return { kind: 'error', message }
  if (isError) return { kind: 'error', message: output }
  const value = unwrapEnvelope(parsed)
  const rows = asRows(value)
  if (rows) return { kind: 'rows', rows }
  if (typeof value === 'string') return { kind: 'text', text: value }
  return { kind: 'json', text: JSON.stringify(value, null, 2) }
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  return typeof value === 'string' ? value : String(value)
}

export function isNumeric(value: unknown): boolean {
  return typeof value === 'number'
}

function columnsOf(rows: Row[]): string[] {
  return [...new Set(rows.flatMap(row => Object.keys(row)))]
}

export type Table = { columns: string[]; widths: number[] }

/** Larguras de uma tabela que caiba em `width`, ou null se não couber. */
export function tableLayout(rows: Row[], width: number): Table | null {
  const columns = columnsOf(rows)
  const widths = columns.map(column =>
    Math.max(column.length, ...rows.map(row => cellText(row[column]).replace(/\n/g, ' ').length)),
  )
  const total = widths.reduce((sum, w) => sum + w, 0) + COLUMN_GAP * Math.max(0, columns.length - 1)
  return total <= width ? { columns, widths } : null
}

export function recordKeyWidth(rows: Row[]): number {
  return Math.max(0, ...columnsOf(rows).map(column => column.length))
}

export function rowCountLabel(count: number): string {
  return count === 1 ? '1 linha' : `${count} linhas`
}

export { COLUMN_GAP }
