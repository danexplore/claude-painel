import { describe, expect, mock, test } from 'claude-code/testing'

import { classifyShell, classifyToolCall, stripRtk } from '../hooks/lib/classify'
import { bar, compactTokens, duration, limitLevel, truncate } from '../hooks/lib/format'
import { activityItems, fitSegments, statusSegments, type Segment } from '../hooks/lib/layout'
import { parseGitStatus, parsePrView } from '../hooks/lib/parse'
import type { Activity } from '../types'

describe('classificação de comandos', () => {
  test('git push --force com rtk é crítico', async () => {
    expect(classifyShell('rtk git push --force origin feat/x')).toBe('critical')
  })

  test('rm -rf é crítico', async () => {
    expect(classifyShell('rm -rf node_modules')).toBe('critical')
  })

  test('supabase db reset --local não é crítico', async () => {
    expect(classifyShell('supabase db reset --local')).toBe('cli')
  })

  test('gh numa chain é integração', async () => {
    expect(classifyShell('rtk git status && rtk gh pr checks')).toBe('cli')
  })

  test('ls é comum', async () => {
    expect(classifyShell('ls -la')).toBe('plain')
  })

  test('rtk é removido em cada parte da chain', async () => {
    expect(stripRtk('rtk git add . && rtk git commit -m x')).toBe('git add . && git commit -m x')
  })

  test('execute_sql com DROP TABLE é crítico', async () => {
    const result = classifyToolCall('mcp__claude_ai_Supabase__execute_sql', { query: 'DROP TABLE users;' })
    expect(result).toEqual({ kind: 'critical', label: 'Supabase · execute_sql', detail: 'DROP TABLE users;' })
  })

  test('execute_sql com SELECT é MCP', async () => {
    expect(classifyToolCall('mcp__claude_ai_Supabase__execute_sql', { query: 'select 1' }).kind).toBe('mcp')
  })

  test('DELETE com WHERE não é crítico', async () => {
    expect(classifyShell("psql -c 'delete from users where id = 1'")).toBe('cli')
  })

  test('apply_migration é crítico', async () => {
    expect(classifyToolCall('mcp__claude_ai_Supabase__apply_migration', {}).kind).toBe('critical')
  })

  test('Edit mostra só o nome do arquivo', async () => {
    expect(classifyToolCall('Edit', { file_path: '/a/b/page.tsx' }).label).toBe('Edit page.tsx')
  })
})

describe('formatação', () => {
  test('tokens compactos', async () => {
    expect([compactTokens(950), compactTokens(4200), compactTokens(142_000), compactTokens(1_000_000)]).toEqual([
      '950',
      '4.2k',
      '142k',
      '1M',
    ])
  })

  test('barra de 5 blocos', async () => {
    expect([bar(0), bar(61), bar(100)]).toEqual(['▱▱▱▱▱', '▰▰▰▱▱', '▰▰▰▰▰'])
  })

  test('duração com largura curta', async () => {
    expect([duration(400), duration(12_300), duration(125_000)]).toEqual(['0.4s', '12s', '2m05'])
  })

  test('truncate usa reticências', async () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })

  test('ritmo: uso acima do tempo decorrido fica amarelo', async () => {
    const window = 5 * 3_600_000
    const now = 0
    const resetsAt = window * 0.8
    expect(limitLevel(60, window, resetsAt, now)).toBe('warn')
  })

  test('ritmo: uso abaixo do tempo decorrido fica neutro', async () => {
    const window = 5 * 3_600_000
    expect(limitLevel(30, window, window * 0.2, 0)).toBe('normal')
  })

  test('ritmo: 90% ou mais fica vermelho', async () => {
    expect(limitLevel(92, 1000, undefined, 0)).toBe('high')
  })
})

describe('leitura de git e PR', () => {
  test('porcelain v2 com branch, ahead/behind e arquivos', async () => {
    const porcelain = [
      '# branch.oid abc',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +1 -2',
      '1 .M N... 100644 100644 100644 a b src/a.ts',
      '? novo.txt',
    ].join('\n')
    expect(parseGitStatus(porcelain, '/home/u/projetos/sonar\n')).toEqual({
      repo: 'sonar',
      branch: 'feat/x',
      changed: 2,
      ahead: 1,
      behind: 2,
    })
  })

  test('gh pr view com checks e aprovação', async () => {
    const json = JSON.stringify({
      number: 412,
      reviewDecision: 'APPROVED',
      statusCheckRollup: [
        { conclusion: 'SUCCESS', status: 'COMPLETED' },
        { conclusion: 'FAILURE', status: 'COMPLETED' },
        { conclusion: '', status: 'IN_PROGRESS' },
        { state: 'PENDING' },
      ],
    })
    expect(parsePrView(json)).toEqual({
      state: 'open',
      number: 412,
      checks: ['pass', 'fail', 'pending', 'pending'],
      review: 'approved',
    })
  })
})

describe('layout da faixa', () => {
  const data = {
    usage: { contextTokens: 142_000, contextWindow: 1_000_000, contextPercent: 14, limits: [] },
    git: { repo: 'sonar', branch: 'feat/x', changed: 3, ahead: 1, behind: 0 },
    pr: { state: 'open' as const, number: 412, checks: ['pass' as const, 'fail' as const], review: null },
    tasks: [{ id: '1', subject: 'a', status: 'completed' as const }],
    unseenCritical: 1,
    startedAt: 1,
    turns: 18,
    now: 1 + 42 * 60_000,
  }

  const ids = (segments: Segment[]) => segments.map(segment => segment.id)

  test('com espaço, mostra tudo', async () => {
    expect(ids(fitSegments(statusSegments(data), 200))).toEqual(['context', 'git', 'pr', 'tasks', 'critical', 'clock'])
  })

  test('estreito, corta o relógio primeiro', async () => {
    const all = statusSegments(data)
    const full = all.reduce((sum, s) => sum + s.pieces.reduce((n, p) => n + p.text.length, 0), 0) + (all.length - 1) * 2
    expect(ids(fitSegments(all, full - 1))).toEqual(['context', 'git', 'pr', 'tasks', 'critical'])
  })

  test('muito estreito, mantém contexto, git e críticos', async () => {
    expect(ids(fitSegments(statusSegments(data), 10))).toEqual(['context', 'git', 'critical'])
  })

  const entry = (id: string, kind: Activity['kind'], status: Activity['status']): Activity => ({
    id,
    startedAt: 0,
    kind,
    label: `cmd-${id}`,
    detail: '',
    status,
  })

  test('crítico não visto fica fixado mesmo sem espaço para os recentes', async () => {
    const list = [entry('a', 'critical', 'ok'), entry('b', 'plain', 'ok'), entry('c', 'cli', 'ok')]
    const items = activityItems(list, ['a'], 12, 0)
    expect(items.map(item => item.activity.id)).toEqual(['a'])
  })

  test('em andamento vem primeiro', async () => {
    const list = [entry('a', 'plain', 'ok'), entry('b', 'cli', 'running')]
    expect(activityItems(list, [], 200, 0).map(item => item.activity.id)).toEqual(['b', 'a'])
  })
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

test('comando crítico aparece fixado na faixa e no contador', async ($, on) => {
  mock.clock(on)
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'rtk git push --force origin feat/x' })
  const ui = await $.ui.mount({ plugin: 'painel', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const counter = await ui.find({ key: 'seg-critical' })
  const pinned = await ui.find({ type: 'Button', text: /git push --force/ })
  expect([counter?.text, pinned !== undefined]).toEqual(['⚠ 1', true])
  await ui.unmount()
})
