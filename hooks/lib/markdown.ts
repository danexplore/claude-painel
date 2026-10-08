export type MarkdownBlock =
  | { kind: 'frontmatter'; entries: [string, string][] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; source: string }
  | { kind: 'table'; header: string[]; alignRight: boolean[]; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'prose'; text: string }

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))
}

/** Tira a marcação inline que não cabe num texto simples (títulos e células de tabela). */
export function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
}

function frontmatter(lines: string[]): { block: MarkdownBlock; next: number } | null {
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return null
  const entries = lines
    .slice(1, end)
    .map(line => /^([\w.-]+):\s*(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => [match[1]!, match[2]!.replace(/^["']|["']$/g, '')] as [string, string])
  return entries.length > 0 ? { block: { kind: 'frontmatter', entries }, next: end + 1 } : null
}

/**
 * Separa o markdown nos blocos que o terminal desenha melhor por conta própria (front-matter, títulos,
 * código, tabelas, citações, linhas); o resto vai junto como prosa para o componente de Markdown.
 */
export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let prose: string[] = []
  const flush = () => {
    const text = prose.join('\n').trim()
    if (text) blocks.push({ kind: 'prose', text })
    prose = []
  }

  const front = frontmatter(lines)
  let index = front?.next ?? 0
  if (front) blocks.push(front.block)

  while (index < lines.length) {
    const line = lines[index]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]!
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.trim().startsWith(marker)) body.push(lines[index++]!)
      index += 1
      blocks.push({ kind: 'code', language: fence[2] ?? '', source: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: plainInline(heading[2]!) })
      index += 1
      continue
    }
    if (line.includes('|') && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      flush()
      const header = tableCells(line).map(plainInline)
      const alignRight = tableCells(lines[index + 1]!).map(cell => /-:$/.test(cell))
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
        rows.push(tableCells(lines[index]!).map(plainInline))
        index += 1
      }
      blocks.push({ kind: 'table', header, alignRight, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quoted: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: quoted.join('\n') })
      continue
    }
    if (RULE.test(line) && !(prose.length > 0 && prose[prose.length - 1]!.trim())) {
      flush()
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }
    prose.push(line)
    index += 1
  }
  flush()
  return blocks
}
