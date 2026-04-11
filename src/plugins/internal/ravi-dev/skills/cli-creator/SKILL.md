---
name: cli-creator
description: |
  Ensina como criar CLIs no ecossistema Ravi. Use quando precisar:
  - Projetar uma nova ferramenta CLI antes de criar uma skill ou agente
  - Padronizar CLIs em `bun + commander`
  - Definir UX agent-first, modelagem de dados e SQLite por dominio
  - Integrar um CLI ao runtime do Ravi com `RAVI_CONTEXT_KEY`
---

# CLI Creator - Teaching Layer

Use esta skill quando o trabalho for criar ou revisar uma ferramenta CLI no ecossistema do Ravi.

Ela existe para manter quatro invariantes:

1. a ferramenta vem antes do agente,
2. o stack padrao e `bun + commander`,
3. o desenho do CLI nasce do problema e do modelo de dados,
4. CLIs integrados ao Ravi usam `RAVI_CONTEXT_KEY` como interface canonica.

## Regra Principal

Ao criar um novo CLI:

- comece pelo problema, nao pelo parser
- modele os dados que agregam valor ao sistema
- desenhe a superficie de comandos para uso por agentes
- persista estado e artefatos em `SQLite` proprio do dominio quando fizer sentido
- se o CLI rodar dentro do Ravi, use o fluxo de `ravi context ...`

## Fluxo Canonico

1. Fazer brainstorm do problema e da decisao que o CLI precisa destravar
2. Definir entidades, artefatos, lineage e o que precisa ser persistido
3. Desenhar comandos `bun + commander` com linguagem autoexplicativa
4. Definir storage em `SQLite` por dominio
5. Implementar a mecanica principal do CLI
6. Integrar `RAVI_CONTEXT_KEY` se houver runtime Ravi no fluxo
7. So depois criar a skill/agente que ensina quando usar o CLI

## Referencias

- Brainstorm e modelagem: `references/brainstorm-e-modelagem.md`
- UX, stack e storage: `references/ux-stack-e-storage.md`
- Context key e runtime Ravi: `references/context-key.md`

## Sinais de Implementacao Ruim

Pare e corrija se encontrar:

- CLI desenhado a partir do parser, sem problema claramente definido
- comandos vagos ou dependentes de conhecimento implicito
- help sem exemplos reais ou sem proximo passo
- banco generico sem ownership claro do dominio
- CLI externo tentando reconstruir identidade sem `RAVI_CONTEXT_KEY`
- agente tentando compensar lacunas de uma ferramenta mal desenhada

## Resultado Esperado

Ao aplicar esta skill, o agente deve conseguir:

- transformar um problema em um CLI claro e reutilizavel
- escolher uma modelagem que maximize valor de dados e rastreabilidade
- implementar CLIs padronizados em `bun + commander`
- explicar quando usar `SQLite` por dominio
- integrar corretamente o contexto do Ravi com `RAVI_CONTEXT_KEY`
