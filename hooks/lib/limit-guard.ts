import type { PluginOptions } from 'claude-code'

export type LimitGuard = { fiveHour: number; weekly: number }

type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

const DEFAULT_FIVE_HOUR = 80
const DEFAULT_WEEKLY = 60

const WINDOWS = [
  { kind: 'five_hour', label: 'janela de 5h', ceiling: (guard: LimitGuard) => guard.fiveHour },
  { kind: 'seven_day', label: 'janela semanal', ceiling: (guard: LimitGuard) => guard.weekly },
]

const percentOr = (value: PluginOptions[string] | undefined, fallback: number): number =>
  typeof value === 'number' && value > 0 && value <= 100 ? value : fallback

export function limitGuardFrom(options: PluginOptions): LimitGuard | undefined {
  if (options.limitGuardEnabled !== true) return undefined
  return {
    fiveHour: percentOr(options.limitGuardFiveHour, DEFAULT_FIVE_HOUR),
    weekly: percentOr(options.limitGuardWeekly, DEFAULT_WEEKLY),
  }
}

// Só o que a pessoa digitou (no terminal ou pelo Remote Control) é travado; aviso de subagente,
// gatilho agendado e demais entregas da máquina passam, senão o resultado delas se perde.
const TYPED_ORIGINS = new Set(['composer', 'bridge'])

export function guardsPrompt(prompt: { origin: { kind: string }; isMeta?: boolean }): boolean {
  return prompt.isMeta !== true && TYPED_ORIGINS.has(prompt.origin.kind)
}

export function guardRefusal(limits: readonly RateLimit[], guard: LimitGuard): string | undefined {
  for (const { kind, label, ceiling } of WINDOWS) {
    const limit = limits.find(item => item.kind === kind)
    const max = ceiling(guard)
    if (!limit || limit.percentUsed < max) continue
    const resets = limit.resetsAt ? ` Zera em ${limit.resetsAt}.` : ''
    return `painel: ${label} em ${limit.percentUsed}% (teto ${max}%).${resets}`
  }
  return undefined
}
