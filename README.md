# claude-painel

Um mod para o Claude Code (terminal, modo tela cheia) que tira as chamadas de ferramenta da conversa e as organiza num painel ao lado, com o uso da sessão numa faixa acima do prompt.

```
◌ 2 edições · 7 ações · 12 leituras · Roda os testes 4s
◑ 258k/1M 26%  5h ▰▱▱▱▱ 8%  7d ▰▰▱▱▱ 29%  ⎇ app·main ●3 ↑1  PR #412 ✓✓✗  ⚠ 1  ◷ 47m·21t
```

```
Atividade  Arquivos 4  Tarefas 2/5       chat: nada
todos 20  ✎ edição 12  ▶ ação 8  leitura ○  ⚠ 1
──────────────────────────────────────────
▾ "corrige o login" · 3 edições · 2 ações             agora
  ✎ auth.ts +40 −12
  ▶ Roda os testes de auth
  · 9 leituras
▸ "sobe a versão" · 1 edição · 1 ação                  12min
```

## O que faz

**Faixa acima do prompt**
- O que o Claude está fazendo no pedido atual: quantas edições, ações e leituras, e o comando que está rodando. Clicar abre a chamada.
- Contexto usado (`usado/total %`), limites de 5h e 7d com barra. A cor muda quando você está gastando mais rápido que o tempo passa.
- Repositório, branch, arquivos modificados, à frente/atrás da origem.
- PR da branch com os checks do CI e a revisão (via `gh`).
- Contador de comandos críticos não vistos (`rm -rf`, `push --force`, `reset --hard`, `supabase db push`, `DROP`/`TRUNCATE`, `prod`…).

**Lista lateral (aberta sozinha a partir de 144 colunas)**
- Cada mensagem sua vira um grupo; só o atual fica aberto.
- Cada chamada é edição (`✎`), ação (`▶`, `◆` para MCP) ou leitura (`·`). Leituras ficam escondidas atrás de um contador.
- O rótulo é a descrição que o Claude escreveu, não o comando cru. Repetidos viram `×N`.
- Clicar expande ali mesmo: comando, saída com `⎿`, e o diff de cada arquivo que mudou, com a linha real.
- `execute_sql` do Supabase: query com cores e resultado como tabela ou registros, sem o envelope.
- Write mostra o conteúdo com cores; `.md` aparece renderizado.
- `t` escolhe o que aparece na conversa: nada, só as edições de arquivo, ou tudo.
- Abas **Atividade**, **Arquivos** (tudo que foi editado na sessão, agrupado por projeto, caminhos a partir da raiz) e **Tarefas**.
- Fechar no `×` recolhe a lista; `a: atividade` na faixa reabre.

## Instalar

No Claude Code:

```
/plugin marketplace add danexplore/claude-painel
/plugin install painel@claude-painel
/reload-plugins
```

Precisa do Claude Code com suporte a mods e do modo tela cheia (`/tui fullscreen`) para os cliques funcionarem. O PR usa o `gh` autenticado.

## Desenvolver

```
claude plugin test .
claude plugin validate .
```

O código fica em `hooks/`: `register.tsx` liga os eventos, `lib/` tem a lógica pura (classificação, layout, diffs, leitura de MCP) e `views/detail.tsx` desenha o detalhe expandido.
