import { describe, expect, mock, test } from 'claude-code/testing'

import { classifyShell, classifyToolCall, isBookkeeping, settleCategory, shortenPaths, stripRtk } from '../hooks/lib/classify'
import { bar, compactTokens, duration, limitLevel, truncate } from '../hooks/lib/format'
import { activityItems, fitSegments, groupByRequest, groupRepeats, matchesFilter, statusSegments, type Segment } from '../hooks/lib/layout'
import { readMcpOutput, tableLayout } from '../hooks/lib/mcp-view'
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
    expect([result.kind, result.category, result.sql]).toEqual(['critical', 'action', 'DROP TABLE users;'])
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

  test('grep por "truncate" não é crítico', async () => {
    expect(classifyShell('grep -n "export function truncate" format.ts')).toBe('plain')
  })

  test('psql com TRUNCATE é crítico', async () => {
    expect(classifyShell('psql -c "TRUNCATE users"')).toBe('critical')
  })

  test('rótulo some com o cd inicial', async () => {
    expect(classifyToolCall('Bash', { command: 'cd ~/x && rtk git status' }).label).toBe('git status')
  })

  test('Bash com descrição usa a descrição como rótulo', async () => {
    expect(classifyToolCall('Bash', { command: 'python3 - <<EOF', description: 'Roda os testes' }).label).toBe('Roda os testes')
  })

  test('sed -i é edição', async () => {
    expect(classifyToolCall('Bash', { command: "sed -i 's/a/b/' x.json" }).category).toBe('edit')
  })

  test('redirecionar para /dev/null não é edição', async () => {
    expect(classifyToolCall('Bash', { command: 'ls > /dev/null' }).category).toBe('action')
  })

  test('Bash marcado como somente leitura vira leitura', async () => {
    expect(settleCategory('action', true)).toBe('read')
  })

  test('Edit conta linhas novas e removidas', async () => {
    expect(classifyToolCall('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y\nz' }).stat).toBe('+2 −1')
  })

  test('Edit guarda um diff da troca', async () => {
    expect(classifyToolCall('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' }).file?.diff).toBe('@@ -1,1 +1,1 @@\n-x\n+y')
  })

  test('Write guarda o conteúdo escrito', async () => {
    expect(classifyToolCall('Write', { file_path: '/a/README.md', content: '# Oi' }).file?.content).toBe('# Oi')
  })

  test('MCP list_ é leitura e execute_sql é ação', async () => {
    const kinds = ['mcp__claude_ai_Supabase__list_tables', 'mcp__claude_ai_Supabase__execute_sql'].map(
      tool => classifyToolCall(tool, { query: 'select 1' }).category,
    )
    expect(kinds).toEqual(['read', 'action'])
  })

  test('caminho longo vira as duas últimas partes', async () => {
    expect(shortenPaths('ls ~/.claude/mods/painel/hooks/lib')).toBe('ls …/hooks/lib')
  })

  test('caminho curto fica como está', async () => {
    expect(shortenPaths('cat ./src/a.ts')).toBe('cat ./src/a.ts')
  })

  test('ToolSearch e plan-progress são bastidor', async () => {
    expect([isBookkeeping('ToolSearch'), isBookkeeping('mcp__plan-progress__plan_progress'), isBookkeeping('Bash')]).toEqual([true, true, false])
  })

  test('edição mostra só o nome do arquivo', async () => {
    expect(classifyToolCall('Edit', { file_path: '/a/b/page.tsx' }).label).toBe('page.tsx')
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
    category: 'action',
    groupId: 'inicio',
    label: `cmd-${id}`,
    detail: '',
    status,
  })

  test('crítico não visto fica fixado mesmo sem espaço para os recentes', async () => {
    const list = [entry('a', 'critical', 'ok'), entry('b', 'plain', 'ok'), entry('c', 'cli', 'ok')]
    const items = activityItems(list, ['a'], 12, 0)
    expect(items.map(item => item.activity.id)).toEqual(['a'])
  })

  test('comando longo é cortado em vez de sumir', async () => {
    const long = { ...entry('a', 'plain', 'ok'), label: 'x'.repeat(300) }
    const items = activityItems([long], [], 40, 0)
    expect(items.map(item => item.label.endsWith('…') && item.label.length <= 38)).toEqual([true])
  })

  test('repetidos seguidos viram um grupo com contagem', async () => {
    const list = [entry('a', 'mcp', 'ok'), { ...entry('b', 'mcp', 'ok'), label: 'cmd-a' }, entry('c', 'cli', 'ok')]
    expect(groupRepeats(list).map(group => group.count)).toEqual([2, 1])
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

test('lista lateral mostra repetidos agrupados', async ($, on) => {
  mock.clock(on)
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'gh --version' })
  await $.tool.call({ tool: 'Bash', command: 'gh --version' })
  const ui = await $.ui.mount({
    plugin: 'painel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'painel',
    props: { bodyColumns: 42, title: 'Atividade' },
  } as never)
  expect((await ui.find({ text: /×2/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('chamada de ferramenta não aparece no chat', async ($, on) => {
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  const ui = await $.ui.mount({
    plugin: 'painel',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
  } as never)
  expect(await ui.find({ text: /ls/ })).toBe(undefined)
  await ui.unmount()
})

describe('visualizador de MCP', () => {
  const envelope = JSON.stringify({
    result:
      'Below is the result of the SQL query.\n\n<untrusted-data-09efa440-e8a5>\n[{"approved_rows":0,"oldest_approved":null}]\n</untrusted-data-09efa440-e8a5>\n\nUse this data',
  })

  test('tira o envelope do Supabase e lê as linhas', async () => {
    expect(readMcpOutput(envelope, false)).toEqual({ kind: 'rows', rows: [{ approved_rows: 0, oldest_approved: null }] })
  })

  test('erro do MCP mostra só a mensagem', async () => {
    expect(readMcpOutput(JSON.stringify({ error: { message: 'relation x does not exist' } }), true)).toEqual({
      kind: 'error',
      message: 'relation x does not exist',
    })
  })

  test('objeto aninhado vira JSON indentado', async () => {
    expect(readMcpOutput('{"a":{"b":1}}', false)).toEqual({ kind: 'json', text: '{\n  "a": {\n    "b": 1\n  }\n}' })
  })

  test('tabela que cabe tem uma largura por coluna', async () => {
    expect(tableLayout([{ id: 12, nome: 'ana' }], 40)?.widths).toEqual([2, 4])
  })

  test('tabela larga demais não vira tabela', async () => {
    expect(tableLayout([{ uma_coluna_bem_longa: 1, outra_coluna_longa: 2 }], 20)).toBe(null)
  })
})

describe('pedidos', () => {
  const call = (id: string, groupId: string, category: Activity['category']): Activity => ({
    id,
    startedAt: 0,
    kind: 'plain',
    category,
    groupId,
    label: id,
    detail: '',
    status: 'ok',
  })

  test('agrupa por pedido, o mais recente primeiro', async () => {
    const views = groupByRequest(
      [call('a', 'r1', 'edit'), call('b', 'r2', 'read')],
      [
        { id: 'r1', text: 'primeiro', startedAt: 0 },
        { id: 'r2', text: 'segundo', startedAt: 1 },
      ],
    )
    expect(views.map(view => view.request.id)).toEqual(['r2', 'r1'])
  })

  test('filtro de edição pega só edições', async () => {
    expect([matchesFilter(call('a', 'r', 'edit'), 'edit'), matchesFilter(call('b', 'r', 'read'), 'edit')]).toEqual([true, false])
  })
})

const PANE_PROPS = { bodyColumns: 60, title: 'Atividade' }

test('lista mostra o resultado do Supabase como registro ao expandir', async ($, on) => {
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  const envelope = JSON.stringify({
    result: 'Below.\n<untrusted-data-abc>\n[{"approved_rows":0,"oldest_approved":null}]\n</untrusted-data-abc>\nUse.',
  })
  on('tool.call', () => ({ result: {}, text: envelope }))
  await $.tool.call({ tool: 'mcp__claude_ai_Supabase__execute_sql', tool_use_id: 'sql1', project_id: 'p', query: 'select 1' } as never)
  const ui = await $.ui.mount({ plugin: 'painel', surface: 'terminal', component: 'Pane', requestId: 'painel', props: PANE_PROPS } as never)
  await ui.press({ key: 'open-sql1' })
  expect((await ui.find({ text: /approved_rows/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('lista mostra o markdown escrito ao expandir um Write', async ($, on) => {
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('tool.call', () => ({ result: {}, text: 'File created successfully' }))
  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/x/NOTAS.md', content: '# Título\n\n- item' } as never)
  const ui = await $.ui.mount({ plugin: 'painel', surface: 'terminal', component: 'Pane', requestId: 'painel', props: PANE_PROPS } as never)
  await ui.press({ key: 'open-w1' })
  expect((await ui.find({ type: 'Markdown' })) !== undefined).toBe(true)
  await ui.unmount()
})
