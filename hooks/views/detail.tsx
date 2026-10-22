import type { Elements, RenderNode } from 'claude-code'

import type { Activity, FileChange } from '../../types'
import { changesOf, diffCounts, projectPath } from '../lib/files'
import { cleanText, duration, truncate } from '../lib/format'
import { cellTone, readShellOutput, splitCommand, type Piece, type ShellOutput, type Tone } from '../lib/shell-view'
import { markdownView } from './markdown'
import {
  COLUMN_GAP,
  MAX_ROWS,
  cellText,
  isNumeric,
  jsonSummary,
  readMcpOutput,
  recordKeyWidth,
  splitRequest,
  rowCountLabel,
  tableLayout,
  type McpOutput,
  type ObjectField,
  type Section,
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
  /** Raízes de projeto (git) já descobertas: caminhos saem como `./…` a partir delas. */
  roots?: string[]
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
  const shown = projectPath(path, options.roots ?? [], options.home)
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

function linesLabel(text: string): string {
  const count = text.split('\n').length
  return count === 1 ? 'texto · 1 linha' : `texto · ${count} linhas`
}

function fieldSummary(value: unknown): string {
  return typeof value === 'object' && value !== null ? jsonSummary(JSON.stringify(value)) : cellText(value)
}

/** A tabela de uma lista de linhas, cortada em MAX_ROWS enquanto não se pede tudo. */
function limitedRows(kit: Kit, id: string, rows: Row[], options: DetailOptions): RenderNode {
  const { Box } = kit
  const shown = options.isFull ? rows : rows.slice(0, MAX_ROWS)
  return (
    <Box key={`${id}-limited`} flexDirection="column">
      {shown.length > 0 && rowsTable(kit, id, shown, options.width)}
      {shown.length < rows.length && showAllButton(kit, id, `mostrar mais · ${rows.length - shown.length}`, options)}
    </Box>
  )
}

/** Objeto de primeiro nível: valores simples em colunas alinhadas, listas de linhas como tabelas com o nome da chave em cima. */
function objectFields(kit: Kit, id: string, fields: ObjectField[], options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  const keyWidth = Math.max(0, ...fields.filter(field => !field.rows && (typeof field.value !== 'object' || field.value === null)).map(field => field.key.length))
  return (
    <Box key={`${id}-object`} flexDirection="column">
      {fields.map((field, index) => {
        const fieldId = `${id}-f${index}`
        if (field.rows) {
          return (
            <Box key={fieldId} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Text>
                <Text bold>{field.key}</Text>
                <Text dimColor> · {rowCountLabel(field.rows.length)}</Text>
              </Text>
              <Box flexDirection="column" paddingLeft={2}>
                {limitedRows(kit, fieldId, field.rows, options)}
              </Box>
            </Box>
          )
        }
        if (typeof field.value === 'object' && field.value !== null) {
          const { text } = limitLines(JSON.stringify(field.value, null, 2), options)
          return (
            <Box key={fieldId} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Text>
                <Text bold>{field.key}</Text>
                <Text dimColor> · {fieldSummary(field.value)}</Text>
              </Text>
              <Box flexDirection="column" paddingLeft={2}>
                <Code source={text} language="json" wrap="wrap" />
              </Box>
            </Box>
          )
        }
        return (
          <Box key={fieldId}>
            <Text dimColor>{field.key.padEnd(keyWidth)}  </Text>
            <Text dimColor={field.value === null} wrap="wrap">
              {cellText(field.value)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** O que a resposta é, em poucas palavras, para o cabeçalho da seção. */
function responseSummary(parsed: McpOutput): string {
  if (parsed.kind === 'rows') return rowCountLabel(parsed.rows.length)
  if (parsed.kind === 'sections') return parsed.sections.map(section => section.title).join(' · ')
  if (parsed.kind === 'object') return `objeto · ${parsed.fields.length === 1 ? '1 chave' : `${parsed.fields.length} chaves`}`
  if (parsed.kind === 'json') return jsonSummary(parsed.text)
  if (parsed.kind === 'text') return linesLabel(parsed.text)
  return 'erro'
}

/** Seção que se lê de relance (o resultado e o erro) fica sempre aberta; as outras, se longas, ficam só com o título. */
const ALWAYS_OPEN_SECTION = /^(?:result|results|error|errors)$/i
const COLLAPSED_SECTION_LINES = 8

function isCollapsed(section: Section, options: DetailOptions): boolean {
  return !options.isFull && !section.isError && !ALWAYS_OPEN_SECTION.test(section.title) && section.text.split('\n').length > COLLAPSED_SECTION_LINES
}

/** Seções de uma resposta em markdown: título em negrito e o corpo recuado, em código, JSON ou texto. */
function sectionList(kit: Kit, id: string, sections: Section[], options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  const collapsed = sections.filter(section => isCollapsed(section, options))
  const collapsedLines = collapsed.reduce((sum, section) => sum + section.text.split('\n').length, 0)
  return (
    <Box key={`${id}-sections`} flexDirection="column">
      {sections.map((section, index) => {
        const { text, total } = limitLines(section.text, options)
        const isCut = !options.isFull && total > options.previewLines
        const margin = index === 0 ? 0 : 1
        if (isCollapsed(section, options)) {
          return (
            <Text key={`${id}-s${index}`} dimColor wrap="truncate-end">
              {section.title} · {total} linhas
            </Text>
          )
        }
        return (
          <Box key={`${id}-s${index}`} flexDirection="column" marginTop={margin}>
            <Text bold color={section.isError ? 'error' : undefined}>
              {section.title}
            </Text>
            <Box flexDirection="column" paddingLeft={2}>
              {section.language ? <Code source={text} language={section.language} wrap="wrap" /> : <Text color={section.isError ? 'error' : undefined} wrap="wrap">{text}</Text>}
              {isCut && showAllButton(kit, `${id}-s${index}`, `ver tudo · ${total} linhas`, options)}
            </Box>
          </Box>
        )
      })}
      {collapsed.length > 0 && showAllButton(kit, `${id}-sections`, `abrir ${collapsed.length === 1 ? 'a seção recolhida' : `as ${collapsed.length} seções recolhidas`} · ${collapsedLines} linhas`, options)}
    </Box>
  )
}

function mcpBody(kit: Kit, entry: Activity, parsed: Exclude<McpOutput, { kind: 'error' }>, options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  const note = 'note' in parsed && parsed.note ? <Text dimColor wrap="wrap">{parsed.note}</Text> : null
  const warning = 'isTruncated' in parsed && parsed.isTruncated ? <Text color="warning">… resposta cortada; o final não foi guardado</Text> : null
  if (parsed.kind === 'rows') {
    return (
      <Box flexDirection="column">
        {limitedRows(kit, entry.id, parsed.rows, options)}
        {warning}
        {note}
      </Box>
    )
  }
  if (parsed.kind === 'sections') return sectionList(kit, entry.id, parsed.sections, options)
  if (parsed.kind === 'object') {
    return (
      <Box flexDirection="column">
        {objectFields(kit, entry.id, parsed.fields, options)}
        {warning}
        {note}
      </Box>
    )
  }
  const { text, total } = limitLines(parsed.text, options)
  return (
    <Box flexDirection="column">
      {parsed.kind === 'json' ? <Code source={text} language="json" wrap="wrap" /> : <Text wrap={textWrap(options)}>{text}</Text>}
      {!options.isFull && total > options.previewLines && showAllButton(kit, entry.id, `ver tudo · ${total} linhas`, options)}
      {warning}
      {note}
    </Box>
  )
}

/** Uma metade da troca: cabeçalho colorido com o que ela é e o recuo do conteúdo, para o olho separar pedido de resposta. */
function exchangeSection(kit: Kit, id: string, header: { title: string; color: string; tail?: string }, body: RenderNode): RenderNode {
  const { Box, Text } = kit
  return (
    <Box key={id} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={header.color} bold>
          {header.title}
        </Text>
        {header.tail && <Text dimColor> · {header.tail}</Text>}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {body}
      </Box>
    </Box>
  )
}

function mcpResponse(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Text } = kit
  const timing = entry.ms !== undefined ? duration(entry.ms) : undefined
  if (entry.status === 'running') {
    return exchangeSection(kit, `${entry.id}-res`, { title: '← resposta', color: 'warning', tail: 'aguardando' }, <Text dimColor>(ainda sem resposta)</Text>)
  }
  const parsed = readMcpOutput(entry.output ?? '', entry.status === 'error')
  const tail = [responseSummary(parsed), timing].filter(Boolean).join(' · ')
  if (parsed.kind === 'error') {
    return exchangeSection(kit, `${entry.id}-res`, { title: '← erro', color: 'error', ...(timing ? { tail: timing } : {}) }, <Text color="error" wrap="wrap">{parsed.message}</Text>)
  }
  return exchangeSection(kit, `${entry.id}-res`, { title: '← resposta', color: 'success', tail }, mcpBody(kit, entry, parsed, options))
}

const COMMAND_PREVIEW_LINES = 8
const TABLE_PREVIEW_ROWS = 10
const TABLE_GAP = 2

const TONE_PROPS: Record<Tone, { color?: string; dimColor?: boolean }> = {
  error: { color: 'error' },
  warning: { color: 'warning' },
  success: { color: 'success' },
  dim: { dimColor: true },
}

/** O comando uma etapa por linha (`&&`, `|` no começo de cada uma), com as cores de shell. */
function commandSection(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Code } = kit
  const steps = splitCommand(entry.detail)
  const shown = options.isFull ? steps : steps.slice(0, Math.max(options.previewLines, COMMAND_PREVIEW_LINES))
  return exchangeSection(
    kit,
    `${entry.id}-cmd`,
    { title: '→ comando', color: 'suggestion', ...(steps.length > 1 ? { tail: `${steps.length} etapas` } : {}) },
    <Box flexDirection="column">
      <Code source={shown.join('\n')} language="bash" wrap="wrap" />
      {shown.length < steps.length && showAllButton(kit, `${entry.id}-cmd`, `comando inteiro · ${steps.length} etapas`, options)}
    </Box>,
  )
}

/** Saída em colunas (gh pr checks, gh run list): alinhada, com a palavra de estado colorida; colunas que não cabem saem pela direita. */
function shellTable(kit: Kit, id: string, rows: string[][], width: number): RenderNode {
  const { Box, Text } = kit
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  const fitted: number[] = []
  let used = 0
  widths.forEach((cellWidth, column) => {
    const cost = cellWidth + (column > 0 ? TABLE_GAP : 0)
    if (used + cost <= width || fitted.length === 0) {
      fitted.push(column)
      used += cost
    }
  })
  const isKeyValue = widths.length === 2
  return (
    <Box key={`${id}-shell-table`} flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box key={`${id}-tr${rowIndex}`}>
          {fitted.map((column, position) => {
            const isLast = position === fitted.length - 1
            const cell = isLast ? truncate(row[column]!, Math.max(4, width - (used - widths[column]!))) : row[column]!
            const tone = cellTone(cell)
            return (
              <Text
                key={`${id}-tr${rowIndex}-c${column}`}
                {...(tone ? TONE_PROPS[tone] : {})}
                dimColor={tone ? tone === 'dim' : isKeyValue && column === 0}
                wrap="truncate-end"
              >
                {isLast ? cell : `${cell.padEnd(widths[column]!)}${' '.repeat(TABLE_GAP)}`}
              </Text>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

function shellLines(kit: Kit, id: string, lines: Piece[][], isError: boolean): RenderNode {
  const { Box, Text } = kit
  return (
    <Box key={`${id}-shell-lines`} flexDirection="column">
      {lines.map((pieces, index) => (
        <Text key={`${id}-ln${index}`} wrap="wrap">
          {pieces.map((piece, pieceIndex) => {
            const tone = piece.tone ?? (isError ? 'error' : undefined)
            return (
              <Text key={`${id}-ln${index}-p${pieceIndex}`} {...(tone ? TONE_PROPS[tone] : {})}>
                {piece.text}
              </Text>
            )
          })}
        </Text>
      ))}
    </Box>
  )
}

function shellSummary(output: ShellOutput): string {
  if (output.kind === 'empty') return 'sem saída'
  if (output.kind === 'data') return responseSummary(output.parsed)
  if (output.kind === 'diff') return `diff · ${output.text.split('\n').length} linhas`
  const count = output.kind === 'table' ? output.rows.length : output.lines.length
  return count === 1 ? '1 linha' : `${count} linhas`
}

function shellBody(kit: Kit, entry: Activity, output: ShellOutput, options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  if (output.kind === 'empty') return <Text dimColor>(sem saída)</Text>
  if (output.kind === 'data') return mcpBody(kit, entry, output.parsed, options)
  if (output.kind === 'diff') {
    const { text, total } = limitLines(output.text, options)
    return (
      <Box flexDirection="column">
        <Code source={text} format="diff" wrap="wrap" />
        {!options.isFull && total > options.previewLines && showAllButton(kit, `${entry.id}-out`, `ver tudo · ${total} linhas`, options)}
      </Box>
    )
  }
  const total = output.kind === 'table' ? output.rows.length : output.lines.length
  const limit = output.kind === 'table' ? Math.max(options.previewLines, TABLE_PREVIEW_ROWS) : options.previewLines
  const shown = options.isFull ? total : Math.min(total, limit)
  return (
    <Box flexDirection="column">
      {output.kind === 'table'
        ? shellTable(kit, entry.id, output.rows.slice(0, shown), options.width)
        : shellLines(kit, entry.id, output.lines.slice(0, shown), entry.status === 'error')}
      {shown < total && showAllButton(kit, `${entry.id}-out`, `… +${total - shown} linhas · ver tudo`, options)}
    </Box>
  )
}

function shellResponse(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Text } = kit
  const id = `${entry.id}-res`
  if (entry.status === 'running') {
    return exchangeSection(kit, id, { title: '← saída', color: 'warning', tail: 'aguardando' }, <Text dimColor>(ainda sem saída)</Text>)
  }
  const output = readShellOutput(entry.detail, entry.output ?? '')
  const isError = entry.status === 'error'
  const tail = [shellSummary(output), entry.ms !== undefined ? duration(entry.ms) : undefined].filter(Boolean).join(' · ')
  return exchangeSection(kit, id, { title: isError ? '← erro' : '← saída', color: isError ? 'error' : 'success', tail }, shellBody(kit, entry, output, options))
}

/** Comando e saída de um Bash, cada um na sua seção, como nas chamadas MCP. */
function shellExchange(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box } = kit
  return (
    <Box key={`${entry.id}-shell`} flexDirection="column">
      {commandSection(kit, entry, options)}
      <Box flexDirection="column" marginTop={1}>
        {shellResponse(kit, entry, options)}
      </Box>
    </Box>
  )
}

/** Pedido e resposta de uma chamada MCP, cada um na sua seção, com uma linha em branco entre elas. */
function mcpExchange(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box } = kit
  return (
    <Box key={`${entry.id}-exchange`} flexDirection="column">
      {exchangeSection(kit, `${entry.id}-req`, { title: '→ pedido', color: 'suggestion', ...(entry.sql ? { tail: 'SQL' } : {}) }, request(kit, entry, options))}
      <Box flexDirection="column" marginTop={1}>
        {mcpResponse(kit, entry, options)}
      </Box>
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

/** Os argumentos da chamada MCP: JSON para os simples, e um bloco de código à parte para o que é script. */
function mcpRequest(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  const { rest, codes } = splitRequest(entry.detail)
  if (!rest.trim() && codes.length === 0) return <Text dimColor>(sem argumentos)</Text>
  const { text, total } = limitLines(rest, options)
  const isRestEmpty = !rest.trim() || rest.trim() === '{}'
  return (
    <Box flexDirection="column">
      {!isRestEmpty && <Code source={text} language="json" wrap="wrap" />}
      {codes.map(({ key, source }, index) => {
        const code = limitLines(source, options)
        return (
          <Box key={`${entry.id}-code-${key}`} flexDirection="column" marginTop={!isRestEmpty || index > 0 ? 1 : 0}>
            <Text dimColor>{key}</Text>
            <Box flexDirection="column" paddingLeft={2}>
              <Code source={code.text} language="javascript" wrap="wrap" />
              {!options.isFull && code.total > options.previewLines && showAllButton(kit, `${entry.id}-code-${key}`, `código inteiro · ${code.total} linhas`, options)}
            </Box>
          </Box>
        )
      })}
      {!isRestEmpty && !options.isFull && total > options.previewLines && showAllButton(kit, `${entry.id}-args`, `pedido inteiro · ${total} linhas`, options)}
    </Box>
  )
}

function request(kit: Kit, entry: Activity, options: DetailOptions): RenderNode {
  const { Box, Text, Code } = kit
  if (entry.sql) {
    const { text, total } = limitLines(entry.sql.trim(), options)
    return (
      <Box flexDirection="column">
        <Code source={text} language="sql" wrap="wrap" />
        {!options.isFull && total > options.previewLines && showAllButton(kit, `${entry.id}-sql`, `query inteira · ${total} linhas`, options)}
      </Box>
    )
  }
  if (entry.isMcp) return mcpRequest(kit, entry, options)
  return commandLine(kit, entry, options)
}

function cleanChange(change: FileChange): FileChange {
  return {
    path: cleanText(change.path),
    ...(change.diff !== undefined ? { diff: cleanText(change.diff) } : {}),
    ...(change.content !== undefined ? { content: cleanText(change.content) } : {}),
  }
}

const MCP_LABEL = /^\S.* · [\w-]+$/
const SQL_TOOLS = /· (execute_sql|apply_migration)$/

/** Chamadas gravadas antes da v0.6 não marcavam MCP nem guardavam a query à parte; deduz pelo rótulo. */
export function withMcpFields(entry: Activity): Activity {
  const isMcp = entry.isMcp ?? (entry.tool?.startsWith('mcp__') || ((entry.kind === 'mcp' || entry.kind === 'critical') && MCP_LABEL.test(entry.label)))
  if (!isMcp) return entry
  const sql = entry.sql ?? (SQL_TOOLS.test(entry.label) && !entry.detail.trimStart().startsWith('{') ? entry.detail : undefined)
  return { ...entry, isMcp: true, ...(sql !== undefined ? { sql } : {}) }
}

function cleanEntry(rawEntry: Activity): Activity {
  const entry = withMcpFields(rawEntry)
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
  if (entry.isMcp) {
    return (
      <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1}>
        {mcpExchange(kit, entry, options)}
        {files.map(file => fileDiff(kit, entry.id, file, options))}
      </Box>
    )
  }
  if (!isFileTool) {
    return (
      <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1}>
        {shellExchange(kit, entry, files.length > 0 ? { ...options, previewLines: Math.min(options.previewLines, CHANGED_OUTPUT_LINES) } : options)}
        {files.map(file => fileDiff(kit, entry.id, file, options))}
      </Box>
    )
  }
  return (
    <Box key={`${entry.id}-detail`} flexDirection="column" paddingBottom={1}>
      {request(kit, entry, options)}
      {files.map(file => fileDiff(kit, entry.id, file, options))}
      {treeOutput(kit, entry, files.length > 0 ? { ...options, previewLines: Math.min(options.previewLines, CHANGED_OUTPUT_LINES) } : options)}
    </Box>
  )
}
