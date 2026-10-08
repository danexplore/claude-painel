# Painel — design

Data: 2026-10-08 · Status: aprovado no brainstorming, aguardando revisão da spec

## Objetivo

Um mod do Claude Code (terminal, renderizador fullscreen, dentro do Orca) que mostra num espaço mínimo o que importa durante uma sessão: uso (contexto, 5h, 7d), estado do git/PR, tarefas e o que o Claude está executando — com destaque para comandos críticos e detalhe sob demanda por clique. Mais um output style que deixa as respostas centradas em decisões.

Substitui o `token-weather-usage` (o usuário desliga o plugin).

## Fora de escopo

- Lista de arquivos alterados e diff: usar o `/diff` nativo (clicável, rolável, por turno).
- Bloquear comandos: o mod só destaca; não nega nada (sessão roda em `bypassPermissions`).
- Auto-accept do Supabase: já feito via hook `Elicitation` em `~/.claude/settings.json`.
- Tasks do Octalab/Colmeia: "tarefas" aqui = lista de tarefas do próprio Claude na sessão.

## 1. Faixa acima do prompt (band, 2 linhas)

```
◔ 142k/1M 14%  5h ▰▰▰▱▱ 61%  7d ▰▰▱▱▱ 38%  │ ⎇ sonar·feat/x ●3 ↑1  PR #412 ✓✓✗  ☐ 2/5  ⚠ 2  ◷ 42m·18t
⠋ pnpm vitest run 3.1s │ ⚠ git push --force │ ◆ supabase·execute_sql · gh pr checks     [atividade]
```

### Linha 1 — estado

| Segmento | Conteúdo | Cor |
|---|---|---|
| Contexto | `◔ usado/total %`; glifo ◔◑◕● por quartil | neutro; amarelo ≥ 70%; vermelho ≥ 85% |
| 5h / 7d | barra de 5 blocos `▰▱` + `%` | neutro se uso% ≤ tempo decorrido% da janela; amarelo se acima do ritmo; vermelho ≥ 90% |
| Git | `⎇ repo·branch`, `●N` arquivos modificados (se N>0), `↑N`/`↓N` vs upstream (se ≠0) | neutro; `↓N` amarelo |
| PR | `PR #N` + um glifo por check (`✓` `✗` `⏳`, máx. 5, depois `+N`) + `aprovado`/`mudanças` se houver revisão | neutro; `✗` vermelho; `mudanças` amarelo |
| Tarefas | `☐ feitas/total` | neutro; clicável → painel na aba Tarefas |
| Críticos | `⚠ N` = críticos ainda não vistos | vermelho negrito; some quando N=0 |
| Relógio | `◷ 42m·18t` (tempo de sessão · turnos) | apagado |

Sem dados → segmento oculto (fora de repo git, sem upstream, sem PR, `gh` ausente). Carregando → `PR …`. Sem PR na branch → `sem PR` apagado.

### Linha 2 — atividade

- À esquerda, se houver tool call em andamento: spinner + comando + tempo correndo.
- Depois, os últimos itens concluídos (mais novo primeiro) até caber, separados por ` · `, apagados; críticos em vermelho/negrito com `⚠`; falhas com `✗` vermelho.
- Críticos não vistos ficam **fixados** logo após o item em andamento até o painel de atividade ser aberto.
- `[atividade]` no fim da linha (Button, hotkey `a`). Clicar em qualquer item também abre o painel com aquele item expandido. A doc de mods só fala em "press": o primeiro passo do plano confirma se `Button` aceita clique no fullscreen; se não aceitar, ficam os atalhos (`a`, e dígitos na band).

### Tela estreita

Nunca quebra linha. Remove segmentos nesta ordem até caber: relógio → detalhe do PR (fica só `PR #N` + pior estado) → 7d → tarefas → itens concluídos da linha 2. Sempre ficam: contexto, 5h, git, `⚠ N`, item em andamento e críticos fixados. Comandos são truncados com `…`.

### Composição com outros mods

A band é uma árvore única: o render do painel chama `await next(e)` e empilha o que vier de outros mods abaixo das suas duas linhas.

## 2. Painel (pane), aberto por clique ou `a`

```
 Atividade [todos] [⚠ 2] [◆ 5] [⚙ 7]      Tarefas
 14:32 ⚠ git push --force origin feat/x        ✓  1.2s
 14:31 ◆ supabase · execute_sql                ✓  0.4s
 14:30 ⚙ gh pr checks 412                      ✗  2.1s
       ├ cwd ~/projetos/sonar · exit 1
       ├ <saída, até 40 linhas>
       └ [ver tudo]
```

- Abas: **Atividade** e **Tarefas**. Filtro ativo em vídeo inverso; cada filtro mostra contagem.
- Lista: horário, ícone, comando/ferramenta truncado, `✓`/`✗`/spinner, duração com largura fixa.
- Clicar numa linha expande/recolhe: comando completo, cwd, exit code (Bash), saída limitada a 40 linhas, `[ver tudo]` para a saída inteira.
- Abrir o painel zera o contador de críticos não vistos.
- `Esc` fecha. Histórico: últimas 200 entradas da sessão (estado da sessão, não persiste).
- Aba Tarefas: `☐` pendente, `◐` em andamento, `☑` concluída, na ordem de criação.

## 3. Classificação de tool calls

Antes de classificar, remove o prefixo `rtk ` e analisa cada comando de uma chain (`&&`, `||`, `;`, `|`); a classe é a mais grave.

| Classe | Ícone | Regra |
|---|---|---|
| Crítico | `⚠` | Bash: `rm -rf`/`rm -fr`, `git push --force`/`-f`/`--force-with-lease`, `git reset --hard`, `git clean -f`, `git branch -D`, `supabase db push`, `supabase db reset` sem `--local`, `vercel --prod`/`deploy --prod`, `DROP`/`TRUNCATE`, `DELETE`/`UPDATE` sem `WHERE`; qualquer comando com `prod`/`production` como palavra. MCP: `apply_migration`, `execute_sql` com SQL que case as regras SQL acima, `delete_*`, `pause_project`, `merge_branch`, `reset_branch`. |
| MCP | `◆` | ferramenta `mcp__<servidor>__<tool>`, exibida como `servidor · tool` (prefixo `claude_ai_` removido) |
| CLI de integração | `⚙` | Bash cujo programa é `gh`, `vercel`, `supabase`, `pnpm`, `npm`, `npx`, `psql`, `curl`, ou `git push`/`pull`/`fetch` |
| Comum | `·` | o resto (inclui Read, Edit, Grep etc., exibidos pelo nome + alvo curto) |

## 4. Dados e eventos

- **Uso**: `$.session.usage()` após `session.measure` → contexto `{tokens, window, percent}` e `rateLimits` (5h/7d). Ritmo = uso% comparado ao % decorrido da janela, calculado a partir do reset informado.
- **Relógio/turnos**: `startedAt` da sessão; turnos contados em `turn.complete`.
- **Tool calls**: hook `tool.call` registra início, **sempre** chama `await next(e)`, registra `isError` e duração, e devolve o resultado intacto. Nunca lança erro nesse caminho (try/catch em tudo que é do painel). Isso mantém os hooks do Orca funcionando.
- **Tarefas**: eventos `classic.TaskCreated` / `classic.TaskCompleted`. O formato do input não está documentado: o plano começa verificando o payload real; se não trouxer título/estado, a aba Tarefas mostra só contagem e o segmento usa o que houver.
- **Git**: `$.process.run(['git','status','--porcelain=v2','--branch'])` e `git rev-parse --show-toplevel`, a cada 10 s e logo após Edit/Write/Bash; sem shell.
- **PR**: `gh pr view --json number,reviewDecision,statusCheckRollup` a cada 60 s e ao trocar de branch; erro/timeout → segmento oculto.
- Redesenho via `ui.invalidate`, respeitando o throttle; timers cancelados no reload.

## 5. Output style "Decisão"

Arquivo `~/.claude/output-styles/decisao.md`, `keep-coding-instructions: true`, ativado com `"outputStyle": "Decisão"` no `settings.json` do usuário. Regras:

- Primeira linha: o resultado ou a decisão que o usuário precisa tomar.
- Decisão = opções curtas (letra + 1 linha) + recomendação em 1 linha.
- Contexto só quando muda a decisão; sem recapitular, sem preâmbulo.
- Mantém texto completo para erros, falhas de teste e ações destrutivas.

## 6. Regras visuais

1. Cor só para exceção; estado normal neutro/apagado.
2. Crítico = ícone + negrito + vermelho + fixado + contador; nunca só cor.
3. Item em andamento separado dos concluídos.
4. Números de largura fixa; truncar com `…`, texto completo ao expandir.
5. Vazio/carregando explícitos ou segmento oculto; nunca segmento vazio.
6. Tela estreita corta por prioridade, nunca quebra linha.
7. Um conjunto de glifos de largura simples (`◔◑◕● ▰▱ ⎇ ● ↑ ↓ ✓ ✗ ⏳ ☐ ◐ ☑ ⚠ ◆ ⚙ · ◷`); nenhum emoji. Verificar largura de `⚠` e `⏳` no terminal do Orca; se forem largura dupla, trocar por `!` e `…`.
8. Painel: filtro ativo destacado, contagens, `Esc` sempre fecha.

## 7. Estrutura e testes

```
~/.claude/mods/painel/
  .claude-plugin/plugin.json
  hooks/register.js        # liga eventos, estado e render
  lib/classify.js          # classificação (pura)
  lib/format.js            # barras, números, truncamento, corte por largura (puro)
  lib/git.js, lib/pr.js    # coleta e parse (parse puro, coleta isolada)
  lib/render-band.js, lib/render-pane.js
  test/*.test.js           # node:test, sem dependências
  docs/specs/
```

- Lógica pura (classificar, formatar, parsear `git status` e JSON do `gh`, cortar por largura) coberta por testes com `node --test`.
- Render e cliques testados pelos meios de teste de mods (pressionar controle por `key`), se disponíveis; senão, verificação manual com `claude --plugin-dir`.
- Carregamento: durante o desenvolvimento `claude --plugin-dir ~/.claude/mods/painel` (hot-reload); depois, instalar como plugin local para valer em toda sessão.

## Critérios de pronto

- Faixa aparece em toda sessão com as 2 linhas, sem quebrar em 100 colunas.
- Um `git push --force` simulado aparece em vermelho, fixado, e `⚠ 1` na linha 1 até abrir o painel.
- Clique num item abre o painel com ele expandido; `Esc` fecha.
- Hooks do Orca continuam disparando (status do agente no Orca segue atualizando).
- Respostas do Claude seguem o formato do estilo "Decisão".
