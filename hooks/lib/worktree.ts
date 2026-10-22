import type { FileChange } from '../../types'

export type Run = (
  argv: readonly string[],
  init?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string }>

/** A árvore do projeto num instante: o hash do git para tudo o que o `git add -A` enxerga (rastreado e novo, sem o ignorado). */
export type TreeMark = { top: string; tree: string }

const STEP_TIMEOUT_MS = 8_000
const MAX_FILES = 30
const MAX_DIFF_CHARS = 60_000

async function output(run: Run, argv: readonly string[], init: { cwd?: string; env?: Record<string, string> } = {}): Promise<string | undefined> {
  const result = await run(argv, { ...init, timeoutMs: STEP_TIMEOUT_MS })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

/**
 * Fotografa a árvore sem mexer no repositório: copia o índice para um arquivo temporário (guarda o cache de stat,
 * então o `add -A` é rápido), adiciona tudo nele e grava a árvore. O índice de verdade nunca é tocado.
 */
export async function markTree(run: Run, token: string): Promise<TreeMark | undefined> {
  const top = await output(run, ['git', 'rev-parse', '--show-toplevel'])
  if (!top) return undefined
  const indexPath = await output(run, ['git', 'rev-parse', '--git-path', 'index'], { cwd: top })
  if (!indexPath) return undefined
  const realIndex = isAbsolute(indexPath) ? indexPath : `${top}/${indexPath}`
  const tempIndex = `${realIndex}.painel-${token.replace(/\W/g, '')}`
  const env = { GIT_INDEX_FILE: tempIndex }
  try {
    await run(['cp', '-f', realIndex, tempIndex], { timeoutMs: STEP_TIMEOUT_MS })
    const added = await output(run, ['git', 'add', '-A'], { cwd: top, env })
    if (added === undefined) return undefined
    const tree = await output(run, ['git', 'write-tree'], { cwd: top, env })
    return tree ? { top, tree } : undefined
  } finally {
    await run(['rm', '-f', tempIndex], { timeoutMs: STEP_TIMEOUT_MS }).catch(() => undefined)
  }
}

function pathOf(block: string): string | undefined {
  const named = (prefix: string) => {
    const line = block.split('\n').find(one => one.startsWith(prefix))
    const name = line?.slice(prefix.length).replace(/\t.*$/, '')
    return name && name !== '/dev/null' ? name.replace(/^[ab]\//, '') : undefined
  }
  return named('+++ ') ?? named('--- ')
}

/** Um arquivo novo vira o conteúdo escrito (a lista mostra "Criou"); o resto fica como diff. */
function changeOf(block: string, top: string): FileChange | undefined {
  if (/^(?:Binary files|GIT binary patch)/m.test(block)) return undefined
  const path = pathOf(block)
  const start = block.search(/^@@/m)
  if (!path || start < 0) return undefined
  const body = block.slice(start).replace(/\n+$/, '')
  const absolute = `${top}/${path}`
  if (/^new file mode/m.test(block)) {
    const content = body
      .split('\n')
      .filter(line => line.startsWith('+'))
      .map(line => line.slice(1))
      .join('\n')
    return { path: absolute, content: content.slice(0, MAX_DIFF_CHARS) }
  }
  return { path: absolute, diff: body.slice(0, MAX_DIFF_CHARS) }
}

export function parseTreeDiff(text: string, top: string): FileChange[] {
  return text
    .split(/^diff --git /m)
    .slice(1)
    .slice(0, MAX_FILES)
    .flatMap(block => {
      const change = changeOf(block, top)
      return change ? [change] : []
    })
}

/** O que mudou entre duas fotografias: só o efeito do comando que rodou no meio, não o que já estava sujo antes. */
export async function changesBetween(run: Run, before: TreeMark, after: TreeMark): Promise<FileChange[]> {
  if (before.tree === after.tree) return []
  const diff = await output(run, ['git', '-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', before.tree, after.tree], {
    cwd: after.top,
  })
  return diff ? parseTreeDiff(diff, after.top) : []
}
