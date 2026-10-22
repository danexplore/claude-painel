import type { Activity } from '../../types'
import { argumentObject, jsonSummary, readMcpOutput, rowCountLabel, type McpOutput, type Row, type Section } from './mcp-view'

const ARGUMENT_KEYS = ['template_name', 'name', 'url', 'element', 'text', 'title', 'subject', 'path', 'file_path', 'action']
const STATUS_KEYS = ['review_status', 'status', 'state', 'result', 'success', 'count', 'total']
const ARGUMENT_HINT_WIDTH = 40
const RESULT_HINT_WIDTH = 28
const CACHE_LIMIT = 300

function oneLine(text: string, width: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** O argumento que diz o que a chamada faz (nome do template, URL, query), para distinguir chamadas da mesma ferramenta. */
export function argumentHint(entry: Pick<Activity, 'detail' | 'sql'>): string {
  if (entry.sql) return oneLine(entry.sql, ARGUMENT_HINT_WIDTH)
  const args = argumentObject(entry.detail)
  if (!args) return ''
  const key = ARGUMENT_KEYS.find(name => isScalar(args[name]) && String(args[name]).trim() !== '')
  if (key) return oneLine(String(args[key]), ARGUMENT_HINT_WIDTH)
  const fallback = Object.entries(args).find(([name, value]) => isScalar(value) && !/(^|_)id$/.test(name))
  return fallback ? oneLine(String(fallback[1]), ARGUMENT_HINT_WIDTH) : ''
}

export type ResultHint = { text: string; isError: boolean }

function statusIn(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const key = STATUS_KEYS.find(name => isScalar((value as Row)[name]))
  return key ? String((value as Row)[key]) : undefined
}

/** Das seções do Playwright, o `Result` diz algo (`{"w":374}`); `Ran Playwright code` e `Page` só repetem o pedido. */
function sectionHint(sections: Section[]): string {
  const failed = sections.find(section => section.isError)
  if (failed) return failed.text
  const result = sections.find(section => /^results?$/i.test(section.title))
  if (!result) return ''
  try {
    return JSON.stringify(JSON.parse(result.text))
  } catch {
    return result.text
  }
}

function hintOf(parsed: McpOutput): ResultHint | undefined {
  if (parsed.kind === 'error') return { text: `✗ ${oneLine(parsed.code ?? parsed.message, RESULT_HINT_WIDTH)}`, isError: true }
  if (parsed.kind === 'sections' && parsed.sections.some(section => section.isError)) return { text: `✗ ${oneLine(sectionHint(parsed.sections), RESULT_HINT_WIDTH)}`, isError: true }
  const text = (() => {
    if (parsed.kind === 'rows') return rowCountLabel(parsed.rows.length)
    if (parsed.kind === 'object') return statusIn(Object.fromEntries(parsed.fields.map(field => [field.key, field.value]))) ?? `${parsed.fields.length} campos`
    if (parsed.kind === 'json') return statusIn(JSON.parse(parsed.text)) ?? jsonSummary(parsed.text)
    if (parsed.kind === 'sections') return sectionHint(parsed.sections)
    return oneLine(parsed.text, RESULT_HINT_WIDTH)
  })()
  return { text: text ? `✓ ${oneLine(text, RESULT_HINT_WIDTH)}` : '✓', isError: false }
}

const cache = new Map<string, ResultHint | null>()

/** Resumo de uma linha da resposta, para a linha fechada da lista: `✗ 2388023`, `✓ PENDING`, `✓ 12 linhas`. */
export function resultHint(entry: Pick<Activity, 'id' | 'status' | 'output'>): ResultHint | undefined {
  if (entry.status === 'running' || entry.output === undefined) return undefined
  const key = `${entry.id}:${entry.status}:${entry.output.length}`
  const known = cache.get(key)
  if (known !== undefined) return known ?? undefined
  const hint = hintOf(readMcpOutput(entry.output, entry.status === 'error'))
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, hint ?? null)
  return hint
}

const SERVER_SEPARATOR = ' · '

/**
 * O rótulo da linha MCP no espaço que há: `servidor · ferramenta · argumento`; faltando lugar, perde o servidor,
 * depois o argumento, e só no fim a ferramenta é cortada.
 */
export function fitMcpLabel(label: string, argument: string, room: number): string {
  const tool = label.includes(SERVER_SEPARATOR) ? label.slice(label.lastIndexOf(SERVER_SEPARATOR) + SERVER_SEPARATOR.length) : label
  const withArgument = (base: string) => (argument ? `${base}${SERVER_SEPARATOR}${argument}` : base)
  const fits = [withArgument(label), withArgument(tool), label, tool].find(candidate => candidate.length <= room)
  if (fits) return fits
  return tool.length <= room ? tool : `${tool.slice(0, Math.max(0, room - 1))}…`
}

const MIN_TOOL_WIDTH = 12
const RESULT_SHARE = 3

/**
 * Rótulo e resumo do resultado numa linha só: o resumo ocupa no máximo um terço, encolhe para o glifo (`✓`/`✗`)
 * e some quando nem a ferramenta cabe, para a linha nunca passar do painel nem quebrar.
 */
export function fitMcpRow(label: string, argument: string, hint: ResultHint | undefined, room: number): { label: string; hint: string } {
  const tool = label.includes(' · ') ? label.slice(label.lastIndexOf(' · ') + 3) : label
  const minLabel = Math.min(tool.length, MIN_TOOL_WIDTH)
  const full = hint ? oneLine(hint.text, Math.max(2, Math.floor(room / RESULT_SHARE))) : ''
  for (const candidate of hint ? [full, hint.text.slice(0, 1)] : []) {
    if (room - candidate.length - 1 >= minLabel) return { label: fitMcpLabel(label, argument, room - candidate.length - 1), hint: candidate }
  }
  return { label: fitMcpLabel(label, argument, room), hint: '' }
}
