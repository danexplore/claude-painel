import type { Elements, RenderNode } from 'claude-code'

import type { PrCheck, PrInfo } from '../../types'
import { dateTime, truncate } from '../lib/format'
import { CHECK_GLYPH, PR_STATUS_LABEL, countChecks, sortedChecks } from '../lib/layout'

export type PrKit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

export type PrViewOptions = {
  width: number
  isPassingShown: boolean
  onRefresh: () => void
  onTogglePassing: () => void
}

const STATUS_COLOR = { open: 'success', draft: undefined, merged: 'merged', closed: 'error' } as const
const CHECK_COLOR = { fail: 'error', pending: 'warning', pass: 'success' } as const
/** `↗ ` à direita de cada check: o link para o job. */
const LINK_ROOM = 2

function checkRow(kit: PrKit, check: PrCheck, index: number, width: number): RenderNode {
  const { Box, Text, Link } = kit
  const name = truncate(check.name, Math.max(8, width - 2 - LINK_ROOM - 1))
  return (
    <Box key={`check-${index}-${check.name}`} justifyContent="space-between">
      <Text>
        <Text color={CHECK_COLOR[check.state]}>{CHECK_GLYPH[check.state]} </Text>
        {check.url ? <Link href={check.url}>{name}</Link> : name}
      </Text>
      {check.url && (
        <Text dimColor>
          <Link href={check.url}>↗</Link>
        </Text>
      )}
    </Box>
  )
}

function emptyState(kit: PrKit, pr: PrInfo | null): RenderNode {
  const { Text } = kit
  if (pr === null) return <Text dimColor>Fora de um repositório git, ou o gh não respondeu.</Text>
  if (pr.state === 'loading') return <Text dimColor>Buscando a PR…</Text>
  return <Text dimColor>Nenhuma PR para esta branch.</Text>
}

/** Aba PR: estado, título, checks com link para o job (ctrl+clique) e revisão, no espírito do painel de PR do VS Code. */
export function prView(kit: PrKit, pr: PrInfo | null, options: PrViewOptions): RenderNode {
  const { Box, Text, Button, Link } = kit
  const { width } = options
  const refresh = <Button key="pr-refresh" plain hotkey="u" dimColor label="↻" onPress={options.onRefresh} />

  if (pr === null || pr.state !== 'found') {
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          {emptyState(kit, pr)}
          {refresh}
        </Box>
      </Box>
    )
  }

  const counts = countChecks(pr.checks)
  const ordered = sortedChecks(pr.checks)
  const shown = options.isPassingShown ? ordered : ordered.filter(check => check.state !== 'pass')
  const updated = dateTime(pr.updatedAt)
  const failing = counts.fail
  const summary =
    failing > 0
      ? { glyph: CHECK_GLYPH.fail, color: 'error', text: `${failing} ${failing === 1 ? 'verificação com falha' : 'verificações com falha'}` }
      : counts.pending > 0
        ? { glyph: CHECK_GLYPH.pending, color: 'warning', text: `${counts.pending} ${counts.pending === 1 ? 'verificação pendente' : 'verificações pendentes'}` }
        : pr.checks.length > 0
          ? { glyph: CHECK_GLYPH.pass, color: 'success', text: 'Todas as verificações passaram' }
          : null
  const review =
    pr.review === 'approved'
      ? { color: 'success', text: '✓ revisão aprovada' }
      : pr.review === 'changes'
        ? { color: 'warning', text: '± mudanças pedidas' }
        : { color: undefined, text: '○ sem revisão' }
  const merge =
    pr.status !== 'open' && pr.status !== 'draft'
      ? null
      : pr.isMergeable === false
        ? { color: 'error', text: '✗ conflito com a base' }
        : pr.isMergeable === true
          ? { color: undefined, text: '✓ sem conflitos' }
          : null

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{pr.url ? <Link href={pr.url}>{`#${pr.number}`}</Link> : `#${pr.number}`}</Text>
          <Text> </Text>
          <Text color={STATUS_COLOR[pr.status]} dimColor={pr.status === 'draft' ? true : undefined} bold>
            {PR_STATUS_LABEL[pr.status].toUpperCase()}
          </Text>
        </Text>
        {refresh}
      </Box>
      {pr.title && <Text wrap="wrap">{pr.title}</Text>}
      {updated && <Text dimColor>PR atualizada {updated}</Text>}
      <Box height={1} />
      {summary && (
        <Text color={summary.color} bold>
          {summary.glyph} {summary.text}
        </Text>
      )}
      <Text color={review.color} dimColor={review.color ? undefined : true}>
        {review.text}
      </Text>
      {merge && (
        <Text color={merge.color} dimColor={merge.color ? undefined : true}>
          {merge.text}
        </Text>
      )}
      {pr.checks.length > 0 && (
        <Box flexDirection="column">
          <Box height={1} />
          <Box columnGap={2}>
            {counts.pass > 0 && (
              <Button
                key="pr-toggle-passing"
                plain
                dimColor
                label={`${options.isPassingShown ? '▾' : '▸'} ${CHECK_GLYPH.pass} ${counts.pass} com sucesso`}
                onPress={options.onTogglePassing}
              />
            )}
            {counts.fail > 0 && <Text color="error">{`${CHECK_GLYPH.fail} ${counts.fail} com falha`}</Text>}
            {counts.pending > 0 && <Text color="warning">{`${CHECK_GLYPH.pending} ${counts.pending}`}</Text>}
          </Box>
          {shown.map((check, index) => checkRow(kit, check, index, width))}
        </Box>
      )}
      {pr.url && (
        <Box flexDirection="column">
          <Box height={1} />
          <Text dimColor>
            <Link href={pr.url}>Abrir no GitHub ↗</Link>
          </Text>
        </Box>
      )}
    </Box>
  )
}
