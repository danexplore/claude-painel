import type { CheckState, GitInfo, PrInfo } from '../../types'

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

type RollupItem = { conclusion?: string | null; status?: string | null; state?: string | null }

const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

function checkState(item: RollupItem): CheckState {
  const outcome = (item.conclusion || item.state || '').toUpperCase()
  if (FAILING.has(outcome)) return 'fail'
  if (PASSING.has(outcome)) return 'pass'
  return 'pending'
}

export function parsePrView(json: string): PrInfo {
  const data = JSON.parse(json) as {
    number: number
    reviewDecision?: string | null
    statusCheckRollup?: RollupItem[] | null
  }
  const review =
    data.reviewDecision === 'APPROVED' ? 'approved' : data.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : null
  return {
    state: 'open',
    number: data.number,
    checks: (data.statusCheckRollup ?? []).map(checkState),
    review,
  }
}
