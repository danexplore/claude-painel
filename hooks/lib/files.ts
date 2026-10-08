import type { Activity, FileChange, FileEvent } from '../../types'

export type FileSummary = {
  path: string
  changes: FileEvent[]
  added: number
  removed: number
  isWritten: boolean
  order: number
}

export const MAX_FILE_EVENTS = 1000

export function diffCounts(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n').filter(line => !line.startsWith('@@'))
  return {
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
  }
}

/** Edit/Write mudam um arquivo; um Bash pode mudar vários (o diff que o Claude Code anota no resultado). */
export function changesOf(entry: Activity): FileChange[] {
  return entry.files ?? (entry.file ? [entry.file] : [])
}

/** `+N −M` das trocas de uma chamada; um arquivo criado conta as linhas escritas. */
export function changesStat(changes: FileChange[]): string {
  const totals = changes.reduce(
    (sum, change) => {
      const counts = change.diff !== undefined ? diffCounts(change.diff) : { added: (change.content ?? '').split('\n').length, removed: 0 }
      return { added: sum.added + counts.added, removed: sum.removed + counts.removed }
    },
    { added: 0, removed: 0 },
  )
  return `+${totals.added} −${totals.removed}`
}

/** Junta trocas sem repetir a mesma (mesma chamada e mesmo arquivo), mantendo a ordem em que aconteceram. */
export function mergeFileEvents(known: FileEvent[], incoming: FileEvent[]): FileEvent[] {
  const seen = new Set(known.map(event => `${event.id}\u0000${event.path}`))
  const fresh = incoming.filter(event => !seen.has(`${event.id}\u0000${event.path}`))
  return [...known, ...fresh].slice(-MAX_FILE_EVENTS)
}

/** Os arquivos mudados na sessão, do mais recente ao mais antigo, com as trocas em ordem. */
export function filesChanged(events: FileEvent[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>()
  events.forEach((event, order) => {
    const counts = event.diff !== undefined ? diffCounts(event.diff) : { added: (event.content ?? '').split('\n').length, removed: 0 }
    const known = byPath.get(event.path)
    byPath.set(event.path, {
      path: event.path,
      changes: [...(known?.changes ?? []), event],
      added: (known?.added ?? 0) + counts.added,
      removed: (known?.removed ?? 0) + counts.removed,
      isWritten: (known?.isWritten ?? false) || event.content !== undefined,
      order,
    })
  })
  return [...byPath.values()].sort((a, b) => b.order - a.order)
}

export function homePath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** A raiz de projeto mais longa que contém o caminho, entre as já descobertas pelo git. */
export function projectRootOf(path: string, roots: string[]): string | undefined {
  return roots
    .filter(root => path.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0]
}

/** `./hooks/lib/x.ts` dentro de um projeto conhecido; `~/…` fora dele. */
export function projectPath(path: string, roots: string[], home: string | undefined): string {
  const root = projectRootOf(path, roots)
  return root ? `.${path.slice(root.length)}` : homePath(path, home)
}

export type ProjectGroup<T> = { root: string | undefined; name: string; files: T[] }

/** Agrupa por projeto, na ordem em que cada projeto aparece pela primeira vez (o mais recente primeiro). */
export function groupByProject<T extends { path: string }>(files: T[], roots: string[]): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>()
  files.forEach(file => {
    const root = projectRootOf(file.path, roots)
    const key = root ?? ''
    const known = groups.get(key)
    if (known) known.files.push(file)
    else groups.set(key, { root, name: root ? root.split('/').pop() || root : 'fora de projeto', files: [file] })
  })
  return [...groups.values()]
}
