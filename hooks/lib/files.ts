import type { Activity } from '../../types'

export type FileSummary = {
  path: string
  changes: Activity[]
  added: number
  removed: number
  isWritten: boolean
  lastAt: number
}

function diffCounts(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n').filter(line => !line.startsWith('@@'))
  return {
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
  }
}

/** Os arquivos que o Claude mudou na sessão, do mais recente ao mais antigo, com as trocas em ordem. */
export function filesChanged(activity: Activity[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>()
  for (const entry of activity) {
    if (!entry.file || entry.status !== 'ok') continue
    const { path, diff, content } = entry.file
    const counts = diff !== undefined ? diffCounts(diff) : { added: (content ?? '').split('\n').length, removed: 0 }
    const known = byPath.get(path)
    byPath.set(path, {
      path,
      changes: [...(known?.changes ?? []), entry],
      added: (known?.added ?? 0) + counts.added,
      removed: (known?.removed ?? 0) + counts.removed,
      isWritten: (known?.isWritten ?? false) || content !== undefined,
      lastAt: entry.startedAt,
    })
  }
  return [...byPath.values()].sort((a, b) => b.lastAt - a.lastAt)
}

export function homePath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
