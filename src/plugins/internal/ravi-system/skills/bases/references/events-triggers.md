# Eventos de linha e triggers

Mudanças de linha chegam ao runtime local pelo inbox bridge que já existe. Não
há subject NATS por base: tudo vem em `ravi.console.inbox.item` com
`category: "bases"`. O runner do inbox lê a linha de cada `bases.row.*` com a
credencial da instalação e anexa os valores ao evento local (`payload.row`).

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

`surface` é `console` (API de sessão do Console; não há tela de Bases), `cli`,
`page` (Ravi Page gerada, via `ravi.bases.*`) ou `system`. O item do Console
nunca traz valores nem chaves de propriedade. O runner local lê a linha uma vez,
com a autorização da instalação, e o evento publicado em
`ravi.console.inbox.item` ganha:

| campo | valor |
|---|---|
| `payload.row` | `{ rowId, version, values, archivedAt }` como lido na entrega (sem `body`; pode ser mais novo que `payload.version`) |
| `payload.rowEnrichment` | `{ status: "ok" }`, ou `{ status: "failed", code }` quando a leitura falhou (aí não há `payload.row`) |

`bases.rows.bulk_changed` não é enriquecido. Para o corpo ou o histórico, leia
a linha:

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
- Uma sessão persistente por item relacionado (ex.: um tópico de fórum e seus
  comentários): `--session forum-{{data.payload.row.values.topic_id.0}}`. Um
  `ref` é uma lista de ids, por isso o `.0`.

```bash
ravi triggers add "Comentário no fórum" \
  --topic "ravi.console.inbox.item" \
  --filter 'data.payload.baseSlug == "comentarios" && data.eventType == "bases.row.created" && data.payload.surface == "page"' \
  --session 'forum-{{data.payload.row.values.topic_id.0}}' \
  --message "Novo comentário no tópico {{data.payload.row.values.topic_id.0}}. Responda gravando um comentário na mesma base." \
  --agent main --cooldown 0s
```

Regras:

- Filtro e `--session` podem usar `data.payload.row.values.*`. Para o corpo,
  o histórico ou um valor atual, leia com `ravi bases rows get`.
- Se `rowEnrichment.status` for `failed` (sem escopo `console.bases.read`,
  linha removida), o template de sessão não resolve e o evento é pulado.
- Se o agent escreve na base que dispara o trigger, use o filtro por `surface`
  ou um cooldown, senão cada escrita gera outro evento.
- `bases.rows.bulk_changed` não tem `rowId`: consulte a base
  (`rows query --sort updated_time:desc`) ou trate como "reprocessar".
