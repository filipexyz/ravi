# Eventos de linha e triggers

Mudanças de linha chegam ao runtime local pelo inbox bridge que já existe. Não
há subject NATS por base: tudo vem em `ravi.console.inbox.item` com
`category: "bases"`. O runner do inbox repassa o item do Console sem alterar.

## Ligar a entrega

A entrega é opt-in por base e por instalação (exige `manage` na base):

```bash
ravi bases subscribe pipeline --json            # inscreve esta instalação
ravi bases subscriptions pipeline --json
ravi bases unsubscribe pipeline <subscription-id> --json
ravi inbox status                               # o poller precisa estar ativo
```

## O item

| campo | valor |
|---|---|
| `category` | `bases` |
| `eventType` | `bases.row.created`, `bases.row.updated`, `bases.row.archived`, `bases.row.restored`, `bases.rows.bulk_changed` (escrita de mais de 50 linhas num request) |
| `payload` | `{ baseId, baseSlug, projectId, rowId, version, schemaVersion, changedPropertyCount, surface }`; bulk: `{ baseId, baseSlug, projectId, rowCount, schemaVersion, surface }` |
| `sensitivity` / `severity` | `metadata` / `info` |
| `dedupeKey` | único por linha, versão, verbo e instalação |

`surface` é `console`, `cli`, `page` ou `system`. O payload nunca traz valores
nem chaves de propriedade: o agent lê a linha com a própria autorização.

```bash
ravi bases rows get <baseId> <rowId> --json
ravi bases rows history <baseId> <rowId> --json   # o que mudou (gerentes; via --view só colunas projetadas)
```

Via `--view`, quem não gerencia a base vê `actorType`, `actorId`, `surface` e
`createdAt` como `null` quando a view não projeta `updated_by` / `updated_time`
(ou `created_by` / `created_time` na entrada `created`).

## Triggers

O filtro usa a gramática de predicados dos triggers sobre `data.*`:

```bash
ravi triggers add "Deal atualizado" \
  --topic "ravi.console.inbox.item" \
  --filter 'data.category == "bases" && data.payload.baseId == "<base-id>" && data.eventType == "bases.row.updated"' \
  --message "Uma linha do pipeline mudou. Leia com ravi bases rows get e, se o estágio for Ganho, avise o canal de vendas." \
  --agent main --session isolated --cooldown 30s
```

Variações úteis:

- Só linhas novas: `data.eventType == "bases.row.created"`.
- Ignorar mudanças feitas pelo próprio CLI (evita loop quando o agent escreve na
  mesma base que observa): `&& data.payload.surface != "cli"`.
- Pedidos vindos de uma Page/formulário: `&& data.payload.surface == "page"`.
- Por slug em vez de id: `data.payload.baseSlug == "pipeline"`.

Regras:

- O trigger recebe metadados. Busque os valores com `ravi bases rows get`; não
  peça valores no texto do trigger.
- Se o agent escreve na base que dispara o trigger, use o filtro por `surface`
  ou um cooldown, senão cada escrita gera outro evento.
- `bases.rows.bulk_changed` não tem `rowId`: consulte a base
  (`rows query --sort updated_time:desc`) ou trate como "reprocessar".
