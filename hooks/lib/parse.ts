import { cleanText } from './format'
import type { CheckState, GitInfo, PrCheck, PrInfo, PrStatus } from '../../types'

export function parseGitStatus(porcelain: string, toplevel: string): GitInfo {
  let branch = '(detached)'
  let ahead = 0
  let behind = 0
  let changed = 0

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(match?.[1] ?? 0)
      behind = Number(match?.[2] ?? 0)
    } else if (line.trim() !== '' && !line.startsWith('#')) {
      changed += 1
    }
  }

  const repo = toplevel.trim().split('/').filter(Boolean).pop() ?? ''
  return { repo, branch, changed, ahead, behind }
}

/** Campos pedidos ao `gh pr view --json`; `parsePrView` lê exatamente estes. */
export const PR_VIEW_FIELDS = 'number,title,url,state,isDraft,updatedAt,mergeable,reviewDecision,statusCheckRollup'

/** Um item do `statusCheckRollup`: `CheckRun` (Actions) traz `name`/`conclusion`, `StatusContext` traz `context`/`state`. */
type RollupItem = {
  name?: string | null
  context?: string | null
  conclusion?: string | null
  status?: string | null
  state?: string | null
  detailsUrl?: string | null
  targetUrl?: string | null
}

const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

function checkState(item: RollupItem): CheckState {
  const outcome = (item.conclusion || item.state || '').toUpperCase()
  if (FAILING.has(outcome)) return 'fail'
  if (PASSING.has(outcome)) return 'pass'
  return 'pending'
}

/** O link de um StatusContext é escrito por apps de fora: só `https:` vira link. */
function httpsUrl(value: string | null | undefined): string | undefined {
  return value && /^https:\/\//i.test(value) ? value : undefined
}

function prCheck(item: RollupItem): PrCheck {
  const url = httpsUrl(item.detailsUrl) ?? httpsUrl(item.targetUrl)
  return { name: cleanText(item.name || item.context || '(sem nome)'), state: checkState(item), ...(url ? { url } : {}) }
}

function prStatus(state: string | undefined, isDraft: boolean | undefined): PrStatus {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return isDraft ? 'draft' : 'open'
}

export function parsePrView(json: string): PrInfo {
  const data = JSON.parse(json) as {
    number: number
    title?: string
    url?: string
    state?: string
    isDraft?: boolean
    updatedAt?: string
    mergeable?: string
    reviewDecision?: string | null
    statusCheckRollup?: RollupItem[] | null
  }
  const review =
    data.reviewDecision === 'APPROVED' ? 'approved' : data.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : null
  return {
    state: 'found',
    number: data.number,
    title: cleanText(data.title ?? ''),
    url: httpsUrl(data.url) ?? '',
    status: prStatus(data.state, data.isDraft),
    updatedAt: data.updatedAt ?? '',
    isMergeable: data.mergeable === 'MERGEABLE' ? true : data.mergeable === 'CONFLICTING' ? false : null,
    checks: (data.statusCheckRollup ?? []).map(prCheck),
    review,
  }
}
