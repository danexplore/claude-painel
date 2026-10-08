import type { Elements, RenderNode } from 'claude-code'

import type { Activity, FileChange } from '../../types'
import { changesOf, diffCounts, homePath } from '../lib/files'
import { cleanText, truncate } from '../lib/format'
import { markdownView } from './markdown'
import {
  COLUMN_GAP,
  MAX_ROWS,
  cellText,
  isNumeric,
  readMcpOutput,
  recordKeyWidth,
  rowCountLabel,
  tableLayout,
  type Row,
} from '../lib/mcp-view'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code' | 'Markdown'>

export type DetailOptions = {
  width: number
  previewLines: number
  isFull: boolean
  onShowAll: () => void
  /** Na aba Arquivos: mostra só a troca deste arquivo, mesmo que o comando tenha mudado vários. */
  onlyPath?: string
  home?: string
  /** Lista lateral: linhas cortadas com … em vez de quebrar, caminhos curtos. */
  isNarrow?: boolean
}

function codeWrap(options: DetailOptions): 'wrap' | 'truncate-end' {
  return options.isNarrow && !options.isFull ? 'truncate-end' : 'wrap'
}

function textWrap(options: DetailOptions): 'wrap' | 'truncate-end' {
  return options.isNarrow && !options.isFull ? 'truncate-end' : 'wrap'
}

const STAT_PART = /([+]\d+|−\d+)/

/** `+N −M` com o mais em verde e o menos em vermelho; o resto do texto, apagado. */
export function coloredStat(kit: Kit, key: string, text: string): RenderNode {
  const { Text } = kit
  return (
    <Text key={key}>
      {text
        .split(STAT_PART)
        .filter(Boolean)
        .map((part, index) => (
          <Text
            key={`${key}-${index}`}
            color={part.startsWith('+') ? 'success' : part.startsWith('−') ? 'error' : undefined}
            dimColor={!STAT_PART.test(part)}
          >
            {part}
          </Text>
        ))}
    </Text>
  )
}

/** Na lista estreita, as duas últimas partes do caminho bastam: `…/.claude-plugin/plugin.json`. */
function displayPath(path: string, options: DetailOptions): string {
  const shown = homePath(path, options.home)
  if (!options.isNarrow) return shown
  const parts = shown.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : shown
}

const TREE = '⎿ '
/** Quando o comando mudou arquivos, o diff é o que importa; a saída fica em poucas linhas. */
const CHANGED_OUTPUT_LINES = 3
/** Um arquivo novo (README, plano, spec) merece mais que a prévia curta de uma saída. */
const CONTENT_PREVIEW_LINES = 20

const GAP = ' '.repeat(COLUMN_GAP)

function rowsTable(kit: Kit, id: string, rows: Row[], width: number): RenderNode {
  const { Box, Text } = kit
  const table = tableLayout(rows, width)
  if (table) {
    const pad = (text: string, column: number, alignRight: boolean) =>
      alignRight ? text.padStart(table.widths[column]!) : text.padEnd(table.widths[column]!)
    return (
      <Box key={`${id}-table`} flexDirection="column">
        <Text dimColor bold>
          {table.columns.map((column, index) => pad(column, index, false)).join(GAP)}
        </Text>
        {rows.map((row, rowIndex) => (
          <Box key={`${id}-r${rowIndex}`}>
            {table.columns.map((column, index) => {
              const value = row[column]
              const text = cellText(value).replace(/\n/g, ' ')
              return (
                <Text key={`${id}-r${rowIndex}-c${index}`} dimColor={value === null || value === undefined}>
                  {pad(text, index, isNumeric(value))}
                  {index < table.columns.length - 1 ? GAP : ''}
                </Text>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  }

  const keyWidth = recordKeyWidth(rows)
  return (
    <Box key={`${id}-records`} flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box key={`${id}-rec${rowIndex}`} flexDirection="column">
          {rows.length > 1 && <Text dimColor>── linha {rowIndex + 1} ──</Text>}
          {Object.entries(row).map(([key, value], index) => (
            <Box key={`${id}-rec${rowIndex}-${index}`}>
              <Text dimColor>{key.padEnd(keyWidth)}  </Text>
              <Text dimColor={value === null || value === undefined}>{cellText(value)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function limitLines(text: string, options: DetailOptions): { text: string; total: number } {
  const lines = text.split('\n')
  return { text: (options.isFull ? lines : lines.slice(0, options.previewLines)).join('\n'), total: lines.length }
}

/** Corta o diff só entre blocos (@@): um bloco pela metade não é lido como diff. O primeiro sempre vai inteiro. */
function limitHunks(diff: string, options: DetailOptions): { text: string; total: number } {
  const lines = diff.split('\n')
  if (options.isFull) return { text: diff, total: lines.length }
  const hunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push([line])
    else hunks[hunks.length - 1]!.push(line)
  }
  const kept: string[][] = []
  let used = 0
  for (const hunk of hunks) {
    if (kept.length > 0 && used + hunk.length > options.previewLines) break
    kept.push(hunk)
    used += hunk.length
  }
  return { text: kept.flat().join('\n'), total: lines.length }
}

function showAllButton(kit: Kit, id: string, label: string, options: DetailOptions): RenderNode {
  const { Button } = kit
  return <Button key={`${id}-all`} plain label={label} onPress={options.onShowAll} />
}

function mcpOutput(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  const parsed = readMcpOutput(entry.output ?? '', entry.status === 'error')
  if (parsed.kind === 'error') return <Text color="error">{parsed.message}</Text>
  if (parsed.kind === 'rows') {
    const shown = options.isFull ? parsed.rows : parsed.rows.slice(0, MAX_ROWS)
    return (
      <Box flexDirection="column">
        <Text dimColor>{rowCountLabel(parsed.rows.length)}</Text>
        {rowsTable(kit, entry.id, shown, options.width)}
        {shown.length < parsed.rows.length && showAllButton(kit, entry.id, `mostrar mais · ${parsed.rows.length - shown.length}`, options)}
      </Box>
    )
  }
  const { text, total } = limitLines(parsed.text, options)
  return (
    <Box flexDirection="column">
      {parsed.kind === 'json' ? <Code source={text} language="json" wrap={codeWrap(options)} /> : <Text wrap={textWrap(options)}>{text}</Text>}
      {!options.isFull && total > options.previewLines && showAllButton(kit, entry.id, `ver tudo · ${total} linhas`, options)}
    </Box>
  )
}

export function fileDiff(kit: Kit, id: string, change: FileChange, options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  const file = cleanChange(change)
  const isMarkdown = /\.(?:md|mdx|markdown)$/i.test(file.path)
  const contentOptions = { ...options, previewLines: Math.max(options.previewLines, CONTENT_PREVIEW_LINES) }
  const { text, total } = file.diff !== undefined ? limitHunks(file.diff, options) : limitLines(file.content ?? '', contentOptions)
  const counts = file.diff !== undefined ? diffCounts(file.diff) : undefined
  const verb = file.diff !== undefined ? 'Atualizou' : 'Criou'
  const stat = counts ? `(+${counts.added} −${counts.removed})` : `(${total} linhas)`
  return (
    <Box key={`${id}-${file.path}`} flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>{TREE}</Text>
        <Text>{verb} </Text>
        <Text bold>{displayPath(file.path, options)}</Text>
        {coloredStat(kit, `${id}-${file.path}-stat`, ` ${stat}`)}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {file.diff !== undefined ? (
          <Code source={text} format="diff" path={file.path} wrap={codeWrap(options)} />
        ) : isMarkdown ? (
          markdownView(kit, `${id}-${file.path}-md`, text, { width: Math.max(20, options.width - 2), isNarrow: options.isNarrow === true })
        ) : (
          <Code source={text} path={file.path} wrap={codeWrap(options)} />
        )}
        {!options.isFull && text.split('\n').length < total && showAllButton(kit, `${id}-${file.path}`, `… +${total - text.split('\n').length} linhas · ver tudo`, options)}
      </Box>
    </Box>
  )
}

/** A saída como o Claude Code mostra: `⎿` na primeira linha, recuo nas outras, sem caixa. */
function treeOutput(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Text } = kit
  const output = (entry.output ?? '').replace(/\s+$/, '')
  if (!output) return <Text dimColor>{TREE}(sem saída)</Text>
  const { text, total } = limitLines(output, options)
  const lines = text.split('\n')
  const isError = entry.status === 'error'
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={`${entry.id}-out-${index}`}>
          <Text dimColor>{index === 0 ? TREE : '  '}</Text>
          <Text color={isError ? 'error' : undefined} dimColor={!isError} wrap={textWrap(options)}>
            {line}
          </Text>
        </Box>
      ))}
      {!options.isFull && total > options.previewLines && showAllButton(kit, entry.id, `  … +${total - options.previewLines} linhas · ver tudo`, options)}
    </Box>
  )
}

/** O comando numa linha só, cortado; inteiro com cores quando a saída é vista toda. */
function commandLine(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Text, Code } = kit
  if (options.isFull && (entry.detail.includes('\n') || entry.detail.length > options.width)) {
    return <Code source={entry.detail} language="bash" wrap="wrap" />
  }
  return <Text dimColor>$ {truncate(entry.detail.split('\n')[0]!, Math.max(8, options.width - 2))}</Text>
}

function request(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Code } = kit
  if (entry.sql) return <Code source={entry.sql.trim()} language="sql" wrap="wrap" />
  if (entry.isMcp) return <Code source={limitLines(entry.detail, { ...options, isFull: false }).text} language="json" wrap="wrap" />
  return commandLine(kit, entry, options)
}

function cleanChange(change: FileChange): FileChange {
  return {
    path: cleanText(change.path),
    ...(change.diff !== undefined ? { diff: cleanText(change.diff) } : {}),
    ...(change.content !== undefined ? { content: cleanText(change.content) } : {}),
  }
}

function cleanEntry(entry: Activity): Activity {
  return {
    ...entry,
    detail: cleanText(entry.detail),
    ...(entry.output !== undefined ? { output: cleanText(entry.output) } : {}),
    ...(entry.sql !== undefined ? { sql: cleanText(entry.sql) } : {}),
  }
}

/** O que aparece ao expandir uma chamada: o pedido (query, comando, argumentos) e a resposta. */
export function entryDetail(kit: Kit, rawEntry: Activity, options: DetailOptions): RenderNode {
  const entry = cleanEntry(rawEntry)
  const { Box, Text } = kit
  const files = changesOf(entry).filter(file => !options.onlyPath || file.path === options.onlyPath)
  const isFileTool = entry.tool !== undefined ? entry.tool !== 'Bash' : entry.detail.startsWith('/')
  if (entry.file || (files.length > 0 && isFileTool)) {
    return (
      <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1}>
        {files.map(file => fileDiff(kit, entry.id, file, options))}
        {entry.status === 'error' && <Text color="error">{entry.output}</Text>}
      </Box>
    )
  }
  return (
    <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1}>
      {request(kit, entry, options)}
      {files.map(file => fileDiff(kit, entry.id, file, options))}
      {entry.isMcp ? mcpOutput(kit, entry, options) : treeOutput(kit, entry, files.length > 0 ? { ...options, previewLines: Math.min(options.previewLines, CHANGED_OUTPUT_LINES) } : options)}
    </Box>
  )
}
