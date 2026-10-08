const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const LIMIT_WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * HOUR },
  seven_day: { label: '7d', ms: 7 * DAY },
}

const BAR_CELLS = 5
const PACE_TOLERANCE = 10
const LIMIT_HIGH = 90
const CONTEXT_WARN = 70
const CONTEXT_HIGH = 85

export type Level = 'normal' | 'warn' | 'high'

export function compactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`
  }
  const millions = tokens / 1_000_000
  return `${millions.toFixed(1).replace(/\.0$/, '')}M`
}

export function contextGlyph(percent: number): string {
  if (percent < 25) return '◔'
  if (percent < 50) return '◑'
  if (percent < 75) return '◕'
  return '●'
}

export function contextLevel(percent: number): Level {
  if (percent >= CONTEXT_HIGH) return 'high'
  return percent >= CONTEXT_WARN ? 'warn' : 'normal'
}

export function bar(percent: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

export function limitLevel(percent: number, windowMs: number, resetsAt: number | undefined, now: number): Level {
  if (percent >= LIMIT_HIGH) return 'high'
  if (resetsAt === undefined) return 'normal'
  const remaining = Math.min(windowMs, Math.max(0, resetsAt - now))
  const elapsedPercent = ((windowMs - remaining) / windowMs) * 100
  return percent > elapsedPercent + PACE_TOLERANCE ? 'warn' : 'normal'
}

export function duration(ms: number): string {
  if (ms < 10 * SECOND) return `${(ms / SECOND).toFixed(1)}s`
  if (ms < MINUTE) return `${Math.round(ms / SECOND)}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m${String(Math.floor((ms % MINUTE) / SECOND)).padStart(2, '0')}`
  return `${Math.floor(ms / HOUR)}h${String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, '0')}`
}

export function sessionClock(ms: number): string {
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  return `${Math.floor(ms / HOUR)}h${String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, '0')}`
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

export function clockTime(epochMs: number): string {
  const date = new Date(epochMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** O Claude Code recusa texto com caractere de controle; tira cores de terminal, \r e o resto, mantém \n e \t. */
export function cleanText(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '')
}
