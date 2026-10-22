export type Row = Record<string, unknown>

/** Campo de primeiro nível de um objeto: lista de linhas planas vira tabela, o resto fica como valor. */
export type ObjectField = { key: string; value: unknown; rows?: Row[] }

/** `note`: texto que veio junto do JSON; `isTruncated`: o JSON chegou cortado e foi fechado à mão. */
type Extras = { note?: string; isTruncated?: true }

/** Uma parte de uma resposta em markdown (`### Título`): `language` quando é código ou JSON, sem ele é texto. */
export type Section = { title: string; text: string; language?: string; isError?: true }

export type McpOutput =
  | ({ kind: 'rows'; rows: Row[] } & Extras)
  | ({ kind: 'object'; fields: ObjectField[] } & Extras)
  | ({ kind: 'json'; text: string } & Extras)
  | { kind: 'sections'; sections: Section[] }
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'text'; text: string }

export const MAX_ROWS = 50
const COLUMN_GAP = 2

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
  return Array.isArray(value) && value.every(isFlatRow) ? value : null
}

const OPEN_TAG = /<untrusted-data-[\w-]+>/g

/**
 * O aviso do Supabase cita a marcação antes de abri-la ("dentro da <untrusted-data-…> abaixo"):
 * o dado começa na última abertura antes do fechamento, não na primeira menção.
 */
function lastOpenTag(text: string, before: number): { end: number } | undefined {
  let found: { end: number } | undefined
  for (const match of text.slice(0, before).matchAll(OPEN_TAG)) found = { end: match.index + match[0].length }
  return found
}

function untrustedBody(text: string): string | undefined {
  const close = text.search(/<\/untrusted-data-/)
  if (close < 0) return undefined
  const open = lastOpenTag(text, close)
  return open ? text.slice(open.end, close).trim() : undefined
}

/**
 * Saída grande chega cortada e o JSON do envelope não fecha, ou o servidor manda o aviso como texto
 * puro: tira o envelope à mão, desfaz os escapes (se houver) e tenta ler o que sobrar.
 */
function salvageEnvelope(raw: string): unknown {
  // O aviso cita a marcação também depois do dado: a abertura certa é a última antes do fechamento.
  const close = raw.search(/<\/untrusted-data-/)
  const open = lastOpenTag(raw, close >= 0 ? close : raw.length)
  if (!open) return undefined
  const escaped = raw.slice(open.end, close >= 0 ? close : raw.length).replace(/^(\\n|\s)+|(\\n|\s)+$/g, '')
  const inner = parseJson(`"${escaped.replace(/\\?$/, '')}"`)
  const text = typeof inner === 'string' ? inner : escaped.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  return parseJson(text) ?? text
}

/**
 * O resultado vem embrulhado em `{"result": "…"}`: o Supabase põe um aviso com o dado entre as tags
 * `untrusted-data`; outros servidores (WhatsApp) mandam o próprio JSON como texto dentro de `result`.
 */
function unwrapEnvelope(value: unknown): unknown {
  const result = typeof value === 'object' && value !== null ? (value as Row)['result'] : undefined
  if (typeof result !== 'string') return value
  const inner = untrustedBody(result)
  if (inner !== undefined) return parseJson(inner) ?? inner
  const decoded = parseJson(result.trim())
  return typeof decoded === 'object' && decoded !== null ? decoded : result
}

type Closer = '}' | ']'

/** Onde termina o primeiro valor JSON do texto, ou os fechos que faltam se o texto acabou antes. */
function scanJson(text: string, start: number): { end: number } | { missing: Closer[]; inString: boolean } {
  const stack: Closer[] = []
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (char === '\\') index++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if ((char === '}' || char === ']') && stack.pop() !== char) return { missing: [], inString: false }
    if (stack.length === 0 && (char === '}' || char === ']')) return { end: index + 1 }
  }
  return { missing: stack.reverse(), inString }
}

const DANGLING_TAILS = [/[\w.+-]+$/, /,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, /,\s*$/, /,?\s*"(?:[^"\\]|\\.)*"\s*$/]

/** Fecha à mão um JSON cortado: aspas abertas e os colchetes que faltam, aparando aos poucos o que ficou sem valor no fim. */
function repairTruncated(text: string, missing: Closer[], inString: boolean): unknown {
  const closers = missing.join('')
  let trimmed = inString ? `${text}"` : text
  const whole = parseJson(`${trimmed}${closers}`)
  if (whole !== undefined) return whole
  for (const tail of DANGLING_TAILS) {
    const next = trimmed.replace(tail, '')
    if (next === trimmed) continue
    trimmed = next
    const value = parseJson(`${trimmed}${closers}`)
    if (value !== undefined) return value
  }
  return undefined
}

const MIN_JSON_SHARE = 0.5

/**
 * Saída que é JSON com texto em volta, ou JSON cortado no meio (o limite de saída do painel, ou do servidor):
 * lê o primeiro valor e devolve o resto à parte. Texto comum com um `[1]` no meio não conta.
 */
function extractJson(output: string): { value: unknown; note?: string; isTruncated?: true } | undefined {
  const text = output.trim()
  const start = text.search(/[{[]/)
  if (start < 0) return undefined
  const scan = scanJson(text, start)
  if ('end' in scan) {
    const value = parseJson(text.slice(start, scan.end))
    const note = `${text.slice(0, start)}\n${text.slice(scan.end)}`.trim()
    const isMostlyJson = start === 0 || scan.end - start >= text.length * MIN_JSON_SHARE
    return value !== undefined && typeof value === 'object' && value !== null && isMostlyJson ? { value, ...(note ? { note } : {}) } : undefined
  }
  if (start > 0 || scan.missing.length === 0) return undefined
  const value = repairTruncated(text, scan.missing, scan.inString)
  return value === undefined ? undefined : { value, isTruncated: true }
}

/** Alguns servidores devolvem os blocos de conteúdo como estão: `[{"type":"text","text":"…"}]`. */
function unwrapContentBlocks(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const isTextBlock = (block: unknown): block is { type: 'text'; text: string } =>
    typeof block === 'object' && block !== null && (block as Row)['type'] === 'text' && typeof (block as Row)['text'] === 'string'
  return value.every(isTextBlock) ? value.map(block => block.text).join('\n') : undefined
}

type ErrorInfo = { message: string; code?: string }

function errorInfo(value: unknown): ErrorInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const error = (value as Row)['error']
  if (typeof error === 'string') return { message: error }
  if (typeof error === 'object' && error !== null && typeof (error as Row)['message'] === 'string') {
    const code = (error as Row)['code']
    return { message: (error as Row)['message'] as string, ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}) }
  }
  return null
}

const SECTION_HEADING = /^### (.+)$/
const FENCE = /^```([\w+-]*)\n([\s\S]*?)\n?```$/

function sectionOf(title: string, body: string): Section {
  const text = body.trim()
  const fence = FENCE.exec(text)
  const isError = /error/i.test(title) ? ({ isError: true } as const) : {}
  if (fence) return { title, text: fence[2]!, ...(fence[1] ? { language: fence[1] } : {}), ...isError }
  const value = parseJson(text)
  if (typeof value === 'object' && value !== null) return { title, text: JSON.stringify(value, null, 2), language: 'json', ...isError }
  return { title, text, ...isError }
}

/**
 * Servidores como o Playwright respondem em markdown: `### Result`, `### Ran Playwright code`, `### Snapshot`…
 * Cada título vira uma seção, e o corpo é lido como código (bloco ```), JSON ou texto.
 */
function readSections(text: string): Section[] | null {
  const lines = text.trim().split('\n')
  if (!SECTION_HEADING.test(lines[0] ?? '')) return null
  const sections: Section[] = []
  let title = ''
  let body: string[] = []
  let isFenced = false
  const flush = () => {
    if (title) sections.push(sectionOf(title, body.join('\n')))
  }
  for (const line of lines) {
    const heading = isFenced ? null : SECTION_HEADING.exec(line)
    if (heading) {
      flush()
      title = heading[1]!.trim()
      body = []
      continue
    }
    if (line.startsWith('```')) isFenced = !isFenced
    body.push(line)
  }
  flush()
  return sections.length > 0 ? sections : null
}

function objectFields(value: unknown): ObjectField[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = Object.entries(value).map(([key, entry]): ObjectField => {
    const rows = asRows(entry)
    return rows && rows.length > 0 ? { key, value: entry, rows } : { key, value: entry }
  })
  return fields.some(field => field.rows) ? fields : null
}

function textOrSections(text: string): McpOutput {
  const sections = readSections(text)
  return sections ? { kind: 'sections', sections } : { kind: 'text', text }
}

function shapeOf(value: unknown, extras: Extras): McpOutput {
  const rows = asRows(value)
  if (rows) return { kind: 'rows', rows, ...extras }
  if (typeof value === 'string') return textOrSections(value)
  const fields = objectFields(value)
  if (fields) return { kind: 'object', fields, ...extras }
  return { kind: 'json', text: JSON.stringify(value, null, 2), ...extras }
}

export function readMcpOutput(output: string, isError: boolean): McpOutput {
  const direct = parseJson(output.trim()) ?? salvageEnvelope(output)
  const loose = direct === undefined ? extractJson(output) : undefined
  const parsed = direct ?? loose?.value
  if (parsed === undefined) return isError ? { kind: 'error', message: readSections(output)?.find(section => section.isError)?.text ?? output } : textOrSections(output)
  const value = unwrapEnvelope(parsed)
  const failure = errorInfo(parsed) ?? errorInfo(value)
  if (failure !== null) return { kind: 'error', ...failure }
  if (isError) return { kind: 'error', message: readSections(output)?.find(section => section.isError)?.text ?? output }
  const blocks = unwrapContentBlocks(value)
  if (blocks !== undefined) return readMcpOutput(blocks, false)
  const extras: Extras = { ...(loose?.note ? { note: loose.note } : {}), ...(loose?.isTruncated ? { isTruncated: true } : {}) }
  return shapeOf(value, extras)
}

/** Uma linha sobre o formato da resposta, para o cabeçalho: `objeto · 3 chaves`, `lista · 4 itens`. */
export function jsonSummary(text: string): string {
  const value = parseJson(text)
  if (Array.isArray(value)) return `lista · ${value.length === 1 ? '1 item' : `${value.length} itens`}`
  if (typeof value === 'object' && value !== null) {
    const count = Object.keys(value).length
    return `objeto · ${count === 1 ? '1 chave' : `${count} chaves`}`
  }
  return 'json'
}

/** O evento da chamada traz `tool` e `tool_use_id` junto dos argumentos; no pedido só os argumentos interessam. */
const EVENT_FIELDS = new Set(['tool', 'tool_use_id', 'agentId'])

export function requestArguments(detail: string): string {
  const value = parseJson(detail)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return detail
  const kept = Object.entries(value).filter(([key]) => !EVENT_FIELDS.has(key))
  return kept.length === Object.keys(value).length ? detail : JSON.stringify(Object.fromEntries(kept), null, 2)
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
  return count === 0 ? 'nenhuma linha' : count === 1 ? '1 linha' : `${count} linhas`
}

export { COLUMN_GAP }

/** Argumentos que são código (o `function` do `browser_evaluate`): saem do JSON e ganham o próprio bloco com cores de JS. */
const CODE_ARGUMENTS = new Set(['function', 'code', 'script', 'expression'])

export type RequestView = { rest: string; codes: Array<{ key: string; source: string }> }

export function splitRequest(detail: string): RequestView {
  const args = requestArguments(detail)
  const value = parseJson(args)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { rest: args, codes: [] }
  const entries = Object.entries(value)
  const codes = entries.flatMap(([key, source]) => (CODE_ARGUMENTS.has(key) && typeof source === 'string' ? [{ key, source }] : []))
  if (codes.length === 0) return { rest: args, codes }
  const rest = entries.filter(([key]) => !codes.some(code => code.key === key))
  return { rest: rest.length > 0 ? JSON.stringify(Object.fromEntries(rest), null, 2) : '', codes }
}

/** Os argumentos da chamada como objeto, sem os campos do evento; undefined se o pedido não é um objeto JSON. */
export function argumentObject(detail: string): Row | undefined {
  const value = parseJson(requestArguments(detail))
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : undefined
}
