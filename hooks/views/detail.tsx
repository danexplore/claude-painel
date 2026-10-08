import type { Elements, RenderNode } from 'claude-code'

import type { Activity } from '../../types'
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

export type DetailOptions = { width: number; previewLines: number; isFull: boolean; onShowAll: () => void }

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
      {parsed.kind === 'json' ? <Code source={text} language="json" wrap="wrap" /> : <Text>{text}</Text>}
      {!options.isFull && total > options.previewLines && showAllButton(kit, entry.id, `ver tudo · ${total} linhas`, options)}
    </Box>
  )
}

function plainOutput(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Text } = kit
  if (!entry.output) return <Text dimColor>(sem saída)</Text>
  const { text, total } = limitLines(entry.output, options)
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Text color={entry.status === 'error' ? 'error' : undefined}>{text}</Text>
      </Box>
      {!options.isFull && total > options.previewLines && showAllButton(kit, entry.id, `ver tudo · ${total} linhas`, options)}
    </Box>
  )
}

function fileChangeView(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Text, Code, Markdown } = kit
  const file = entry.file!
  const isMarkdown = /\.(?:md|mdx|markdown)$/i.test(file.path)
  const body = file.diff ?? file.content ?? ''
  const { text, total } = file.diff !== undefined ? limitHunks(file.diff, options) : limitLines(body, options)
  return (
    <Box flexDirection="column">
      <Text dimColor>{file.path}</Text>
      {file.diff !== undefined ? (
        <Code source={text} format="diff" path={file.path} wrap="wrap" />
      ) : isMarkdown ? (
        <Markdown text={text} />
      ) : (
        <Code source={text} path={file.path} wrap="wrap" />
      )}
      {!options.isFull && total > options.previewLines && showAllButton(kit, entry.id, `ver tudo · ${total} linhas`, options)}
      {entry.status === 'error' && <Text color="error">{entry.output}</Text>}
    </Box>
  )
}

function request(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Text, Code } = kit
  if (entry.sql) return <Code source={entry.sql.trim()} language="sql" wrap="wrap" />
  if (entry.isMcp) return <Code source={limitLines(entry.detail, { ...options, isFull: false }).text} language="json" wrap="wrap" />
  if (entry.detail.includes('\n') || entry.detail.length > options.width) {
    return <Code source={limitLines(entry.detail, { ...options, isFull: false }).text} language="bash" wrap="wrap" />
  }
  return <Text dimColor>{entry.detail}</Text>
}

/** O que aparece ao expandir uma chamada: o pedido (query, comando, argumentos) e a resposta. */
export function entryDetail(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box } = kit
  if (entry.file) {
    return (
      <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1}>
        {fileChangeView(kit, entry, options)}
      </Box>
    )
  }
  return (
    <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1} gap={1}>
      {request(kit, entry, options)}
      {entry.isMcp ? mcpOutput(kit, entry, options) : plainOutput(kit, entry, options)}
    </Box>
  )
}
