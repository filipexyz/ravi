# Slack Work Objects

Use Work Objects nativos quando o Slack deve reconhecer um objeto externo como
entidade propria, com preview/unfurl, flexpane e `external_ref`. Nao confunda
com card Block Kit: Block Kit renderiza UI de mensagem; Work Objects usam
`metadata` nos metodos Slack.

## Pre-requisitos

- O app Slack precisa ter Work Object Previews habilitado nas configuracoes.
- Se usar unfurl, o app precisa de dominio registrado e scope `links:write`.
- `chat.unfurl` deve ser chamado a partir de um `link_shared` real para a URL
  postada; chamadas manuais contra mensagens arbitrarias podem retornar
  `cannot_unfurl_url`.
- Mensagens postadas pelo proprio bot podem nao gerar `link_shared`; para smoke
  de unfurl/flexpane, poste a URL como usuario no Slack.
- Para notificacoes diretas por `chat.postMessage`, `app_unfurl_url` nao e
  obrigatorio.
- Para flexpane, o app precisa receber `entity_details_requested` e responder
  com `entity.presentDetails`.

## Comandos

Validar metadata de mensagem/unfurl:

```bash
ravi slack work-objects-validate ./metadata.json --json
```

Enviar notificacao com Work Object nativo:

```bash
ravi slack work-objects-send C123 ./message.json --execute --json
```

Aplicar Work Object a uma URL recebida em `link_shared`:

```bash
ravi slack work-objects-unfurl C123 1713000000.000100 https://example.com/tasks/123 ./metadata.json --execute --json
```

Responder a `entity_details_requested` com metadata de flexpane:

```bash
ravi slack work-objects-present-details <triggerId> ./detail.json --execute --json
```

Todos os comandos de mutacao sao dry-run sem `--execute`.

## Metadata De Mensagem

Formato aceito por `work-objects-send` e `work-objects-unfurl`:

```json
{
  "text": "Fallback acessivel",
  "metadata": {
    "entities": [
      {
        "url": "https://example.com/tasks/123",
        "external_ref": {
          "id": "123",
          "type": "task"
        },
        "entity_type": "slack#/entities/task",
        "entity_payload": {
          "attributes": {
            "title": { "text": "Revisar release" },
            "display_type": "Task",
            "product_name": "Ravi",
            "metadata_last_modified": 1783910000
          },
          "fields": {
            "status": {
              "value": "open",
              "tag_color": "blue"
            }
          },
          "display_order": ["status"]
        }
      }
    ]
  }
}
```

Tipos suportados pelo Slack nesta integracao:

- `slack#/entities/file`
- `slack#/entities/task`
- `slack#/entities/incident`
- `slack#/entities/content_item`
- `slack#/entities/item`

## Flexpane

`entity.presentDetails` recebe uma unica entidade, sem wrapper `entities`.
O comando aceita tanto o formato de mensagem com um unico item quanto a entidade
direta e normaliza para o formato da API.

```json
{
  "entity_type": "slack#/entities/task",
  "url": "https://example.com/tasks/123",
  "external_ref": { "id": "123", "type": "task" },
  "entity_payload": {
    "attributes": {
      "title": { "text": "Revisar release" },
      "display_type": "Task",
      "product_name": "Ravi"
    },
    "fields": {
      "status": { "value": "open", "tag_color": "blue" }
    }
  }
}
```

## Interacoes

Acoes de Work Objects chegam como `block_actions` normais. A diferenca esta no
`container`: Slack inclui `entity_url`, `external_ref`, `app_unfurl_url`,
`message_ts`, `thread_ts` e `channel_id`. Use esses campos para rotear a acao
ao objeto externo correto.

Eventos de URL e flexpane sao publicados em `ravi.inbound.interaction`:

- `interactionType == "link_shared"`: contem `links[]`, `channelId` e
  `messageTs`; use para chamar `work-objects-unfurl`.
- `interactionType == "entity_details_requested"`: contem `entityUrl`,
  `appUnfurlUrl`, `externalRef`, `triggerId`, `channelId`, `messageTs` e
  `threadTs`; use para chamar `work-objects-present-details`.

Exemplo de filtros:

```bash
ravi triggers add "Slack Work Object unfurl" \
  --topic "ravi.inbound.interaction" \
  --filter 'data.provider == "slack" && data.interactionType == "link_shared"' \
  --shell 'bun scripts/slack-work-object-unfurl.ts' \
  --timeout 30s \
  --on-error notify-session:<session>

ravi triggers add "Slack Work Object details" \
  --topic "ravi.inbound.interaction" \
  --filter 'data.provider == "slack" && data.interactionType == "entity_details_requested"' \
  --shell 'bun scripts/slack-work-object-details.ts' \
  --timeout 30s \
  --on-error notify-session:<session>
```

Nao use prefixos de `block_id` de cards Block Kit para detectar Work Objects.
Isso e card fake, nao Work Object nativo.
