# Atividade v2: tipos, pedidos e visualizador de MCP

## Tipos de chamada

| Tipo | Ícone | Rótulo | Detalhe |
|---|---|---|---|
| Edição | `✎` amarelo | nome do arquivo | `+N −M`, ou `N linhas` no Write |
| Ação | `▶` ciano (MCP em magenta) | `description` do Bash, ou `servidor · ferramenta` | `✗ código` quando falha, duração |
| Leitura | `·` apagado | descrição, ou arquivo/padrão | duração |
| Crítico | `⚠` vermelho | o do tipo | fixado; continua sendo uma ação ou edição |

- Leitura: Read, Grep, Glob, LS, WebFetch, WebSearch; Bash que o Claude Code marcou `isReadOnly`; MCP `get_`, `list_`, `search_`, `read_`, `fetch_`.
- Edição: Edit, MultiEdit, Write, NotebookEdit; Bash com `sed -i`, `perl -i`, `tee` ou redirecionamento `>`/`>>` para arquivo.
- Ação: o resto. `execute_sql` é sempre ação.
- O rótulo do Bash é a `description` da chamada; o comando cru aparece ao expandir.

## Pedidos

- Cada `prompt.submit` abre um grupo com o começo do texto. Chamadas antes do primeiro pedido caem em "início da sessão".
- O grupo mais recente fica aberto, os anteriores recolhidos numa linha: `▸ "texto" · 2 edições · 1 ação · 9 leituras   12min`. Clicar abre ou fecha.
- As leituras ficam atrás de `N leituras`, clicável por grupo, ou do interruptor global `leitura ○/●` no topo.

## Topo da lista lateral

`edição N  ação N  leitura ○  ⚠ N`: os três primeiros filtram (clicar de novo volta a todos), `leitura` liga/desliga as leituras. A legenda e os filtros MCP/CLI saem.

## Visualizador de MCP

- Query de `execute_sql`/`apply_migration`: elemento `Code` com `language="sql"`, sem reformatar.
- Resultado de `execute_sql`: tira o envelope (`result` → conteúdo entre `<untrusted-data-…>`) e lê o JSON.
  - Cabe na largura: tabela com cabeçalho, números à direita, `null` apagado.
  - Não cabe (lista lateral, muitas colunas): um registro por linha, chave à esquerda.
  - Acima de 50 linhas: só as 50 primeiras e `mostrar mais`.
- Outros MCP: JSON indentado num `Code` com `language="json"`; lista de objetos simples vira tabela.
- Erro: a mensagem em vermelho, sem envelope.

## Fora do escopo

Preview de imagem (testado e retirado).
