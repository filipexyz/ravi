---
name: routes-manager
description: |
  Consulta e gerencia rotas do Ravi. Use para listar, mostrar ou explicar rotas
  pela fachada somente de leitura e também para criar, ajustar, remover ou
  restaurar rotas pelo grupo legado de mutação.
---

# Routes Manager

`ravi routes` é uma fachada somente de leitura. Ela oferece três operações:

```bash
ravi routes list [instance] --json
ravi routes show <instance> <stored-pattern> --json
ravi routes explain <instance> <concrete-target> --json
```

## Regras de operação

- Use `list` para descobrir rotas e siga `pagination.nextCommand` enquanto
  `hasMore` for verdadeiro.
- Use `show` com o pattern exatamente como foi gravado.
- Use `explain` para aceitar formatos concretos equivalentes. Por exemplo,
  `group:X` e `X@g.us` representam o mesmo grupo; números e `phone:+X` também
  compartilham a forma canônica usada pelo resolvedor.
- Um glob como `5511*` não é um alvo concreto. Se o resultado for
  `skipped_broad_pattern`, forneça um número concreto para simular; nunca trate
  esse estado como prova de ausência.
- Leia `origin` antes do veredito. `kind:config_simulation` e
  `daemonObserved:false` significam que a configuração persistida foi
  simulada, mas a memória atual do daemon não foi consultada.
- Se houver `ROUTE_PATTERN_AMBIGUOUS`, escolha explicitamente um dos patterns
  gravados em `suggestions`; não selecione por ordem ou semelhança.
- Se `--channel` for inválido, corrija usando `acceptedChannels`. Se houver
  `ROUTE_CHANNEL_AMBIGUOUS`, repita com uma das grafias exatas em `suggestions`;
  não escolha por ordem nem normalize silenciosamente.

## Projeção e paginação

`routes list --fields pattern,agent,channel --json` reduz cada item. Campos
aceitos: `id`, `accountId`, `pattern`, `agent`, `priority`, `policy`, `session`,
`channel`, `dmScope` e `tags`. Campo desconhecido é erro de uso, inclusive
quando não há rotas.

Limite máximo: 500. Limite inválido ou maior que o máximo falha; não existe
redução silenciosa. Para consumidores novos, `items` é a coleção canônica;
`routes` permanece como alias de compatibilidade.

## Erros e parada

- Exit `0`: leitura concluída.
- Exit `1`: alvo ausente, ambíguo ou falha de execução. Leia `error.code`,
  `suggestions` e `suggestedAction`.
- Exit `2`: entrada inválida. Corrija campos, paginação ou canal antes de
  tentar novamente.

## Alterações de configuração

As leituras ficam na fachada `ravi routes`; as alterações continuam no grupo
legado `ravi instances routes`. Elas gravam imediatamente e não usam
`--execute`, portanto confirme instância, pattern, agent e canal antes de rodar:

```bash
ravi instances routes add <instance> <pattern> <agent> [--priority <n>]
ravi instances routes set <instance> <pattern> <key> <value>
ravi instances routes remove <instance> <pattern>
ravi instances routes restore <instance> <pattern>
ravi instances routes deleted [instance]
```

Chaves aceitas por `set`: `agent`, `priority`, `dmScope`, `session`, `policy` e
`channel`; use `-` para limpar o canal. `remove` é recuperável por `restore`.
Não transforme automaticamente um `not-found`, uma ambiguidade ou uma
simulação inconclusiva em escrita: primeiro descubra os valores reais e peça a
confirmação exigida pelo contexto da operação.

## Prioridade e sessões

A resolução tenta primeiro `thread:ID`, depois grupo, telefone/glob, o agent da
instância e, por último, o agent padrão. Dentro do mesmo nível, canal específico
vence canal genérico e prioridade maior vence prioridade menor.

`route` escolhe qual agent recebe o chat; `sessions attach` liga um chat a uma
sessão já escolhida. Se a rota aponta para o agent errado, corrija a rota antes
de usar `attach`. Para direcionar desde a rota a uma sessão canônica, use
`instances routes add ... --session <name>`.
