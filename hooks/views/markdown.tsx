import type { RenderNode } from 'claude-code'

import { markdownBlocks, type MarkdownBlock } from '../lib/markdown'
import type { Kit } from './detail'

export type MarkdownOptions = { width: number; isNarrow: boolean }

const HEADING_COLOR = ['claude', 'suggestion', 'permission'] as const
const CELL_GAP = '  '

function heading(kit: Kit, key: string, block: Extract<MarkdownBlock, { kind: 'heading' }>, options: MarkdownOptions): RenderNode {
  const { Box, Text } = kit
  const color = HEADING_COLOR[block.level - 1]
  return (
    <Box key={key} flexDirection="column" marginTop={block.level <= 2 ? 1 : 0}>
      <Text bold color={color}>
        {block.level >= 3 ? `${'#'.repeat(block.level)} ` : ''}
        {block.text}
      </Text>
      {block.level === 1 && <Text color="claude">{'━'.repeat(Math.min(options.width, Math.max(block.text.length, 12)))}</Text>}
      {block.level === 2 && <Text dimColor>{'─'.repeat(Math.min(options.width, Math.max(block.text.length, 8)))}</Text>}
    </Box>
  )
}

function code(kit: Kit, key: string, block: Extract<MarkdownBlock, { kind: 'code' }>, options: MarkdownOptions): RenderNode {
  const { Box, Text, Code } = kit
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {block.language && <Text dimColor>{block.language}</Text>}
      <Code source={block.source} {...(block.language ? { language: block.language } : {})} wrap={options.isNarrow ? 'truncate-end' : 'wrap'} />
    </Box>
  )
}

function table(kit: Kit, key: string, block: Extract<MarkdownBlock, { kind: 'table' }>, options: MarkdownOptions): RenderNode {
  const { Box, Text } = kit
  const columns = block.header.length
  const widths = block.header.map((cell, column) => Math.max(cell.length, ...block.rows.map(row => (row[column] ?? '').length)))
  const total = widths.reduce((sum, width) => sum + width, 0) + CELL_GAP.length * (columns - 1)

  if (total > options.width) {
    const keyWidth = Math.max(...block.header.map(cell => cell.length))
    return (
      <Box key={key} flexDirection="column">
        {block.rows.map((row, rowIndex) => (
          <Box key={`${key}-r${rowIndex}`} flexDirection="column">
            {rowIndex > 0 && <Text dimColor>{'·'.repeat(Math.min(options.width, 12))}</Text>}
            {block.header.map((cell, column) => (
              <Text key={`${key}-r${rowIndex}-${column}`} wrap="wrap">
                <Text dimColor>{cell.padEnd(keyWidth)}  </Text>
                {row[column] ?? ''}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  }

  const cell = (text: string, column: number) =>
    block.alignRight[column] ? text.padStart(widths[column]!) : text.padEnd(widths[column]!)
  return (
    <Box key={key} flexDirection="column">
      <Text bold>{block.header.map(cell).join(CELL_GAP)}</Text>
      <Text dimColor>{widths.map(width => '─'.repeat(width)).join(CELL_GAP)}</Text>
      {block.rows.map((row, rowIndex) => (
        <Text key={`${key}-r${rowIndex}`}>{block.header.map((_, column) => cell(row[column] ?? '', column)).join(CELL_GAP)}</Text>
      ))}
    </Box>
  )
}

function block(kit: Kit, key: string, item: MarkdownBlock, options: MarkdownOptions): RenderNode {
  const { Box, Text, Markdown } = kit
  switch (item.kind) {
    case 'frontmatter': {
      const keyWidth = Math.max(...item.entries.map(([name]) => name.length))
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {item.entries.map(([name, value], index) => (
            <Text key={`${key}-${index}`} wrap={options.isNarrow ? 'truncate-end' : 'wrap'}>
              <Text dimColor>{name.padEnd(keyWidth)}  </Text>
              {value}
            </Text>
          ))}
        </Box>
      )
    }
    case 'heading':
      return heading(kit, key, item, options)
    case 'code':
      return code(kit, key, item, options)
    case 'table':
      return table(kit, key, item, options)
    case 'quote':
      return (
        <Box key={key} flexDirection="column">
          {item.text.split('\n').map((line, index) => (
            <Box key={`${key}-${index}`}>
              <Text color="suggestion">▎ </Text>
              <Markdown text={line || ' '} dimColor />
            </Box>
          ))}
        </Box>
      )
    case 'rule':
      return <Text key={key} dimColor>{'─'.repeat(Math.min(options.width, 40))}</Text>
    case 'prose':
      return <Markdown key={key} text={item.text} />
  }
}

/** Markdown desenhado bloco a bloco: títulos com cor, código em caixa com cores, tabelas alinhadas. */
export function markdownView(kit: Kit, key: string, markdown: string, options: MarkdownOptions): RenderNode {
  const { Box } = kit
  return (
    <Box key={key} flexDirection="column" gap={0}>
      {markdownBlocks(markdown).map((item, index) => block(kit, `${key}-b${index}`, item, options))}
    </Box>
  )
}

