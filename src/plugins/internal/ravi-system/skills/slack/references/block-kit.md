# Slack Block Kit

Use Block Kit quando a resposta precisa de UI interativa no Slack: botoes,
selects, menus, agrupamento visual ou uma acao que deve virar evento Ravi.

Canvas e documento. Block Kit e mensagem/modal interativa. Nao use Block Kit
para publicar runbooks longos; use Canvas/artifacts.

## Comandos

Validar:

```bash
ravi slack blocks-validate ./message.json --json
```

Enviar:

```bash
ravi slack blocks-send C123 ./message.json --execute --json
```

Atualizar:

```bash
ravi slack blocks-update C123 1713000000.000100 ./message.json --execute --json
```

Showcase:

```bash
ravi slack blocks-showcase C123 --execute --json
```

Responder uma interacao via handle seguro:

```bash
ravi slack interactions-respond <responseUrlId> ./response.json --execute --json
```

## Payload De Mensagem

Formato recomendado:

```json
{
  "text": "Fallback acessivel",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "Escolha uma acao"
      }
    },
    {
      "type": "actions",
      "block_id": "approval_actions",
      "elements": [
        {
          "type": "button",
          "action_id": "approve",
          "text": {
            "type": "plain_text",
            "text": "Aprovar"
          },
          "style": "primary",
          "value": "approve"
        }
      ]
    }
  ]
}
```

`text` top-level e obrigatorio para fallback de notificacao/acessibilidade.

## Interacoes

Cliques e selects chegam via Socket Mode e sao publicados como:

```text
ravi.inbound.interaction
```

Campos uteis para triggers:

- `provider`
- `interactionType`
- `userId`
- `channelId`
- `messageTs`
- `threadTs`
- `actionId`
- `blockId`
- `value`
- `selectedOption`
- `responseUrlId`

Exemplo:

```bash
ravi triggers add "Slack approve" --topic "ravi.inbound.interaction" --filter 'data.provider == "slack" && data.actionId == "approve"' --message "Aprovado por {{data.userId}}"
```

Para automacoes deterministicas, prefira trigger shell:

```bash
ravi triggers add "Slack ticket flow" \
  --topic "ravi.inbound.interaction" \
  --filter 'data.provider == "slack" && data.interactionType == "block_actions" && data.blockId startsWith "ravi_ticket_"' \
  --shell 'bun scripts/slack-ticket-flow.ts' \
  --timeout 30 \
  --on-error notify-session:ravi-channels
```

O shell recebe `RAVI_TRIGGER_EVENT_FILE` com o payload canonico e pode atualizar
a mensagem via `ravi slack blocks-update` ou cliente Slack nativo. Nao use
prompt de agent para fluxo que e puro estado + mutacao.
Use conexao explicita apenas fora de um contexto Slack resolvivel.

Para fluxos multi-etapa com state local, idempotencia, filtros em paralelo e
exemplos de tickets/aprovacoes/deploy, leia `references/block-kit-workflows.md`.

Nao confie em `value` como dado interno: ele vem do payload interativo e deve ser
tratado como input de usuario.

## Regras

- Mutacoes sao dry-run por padrao.
- Use `blocks-validate` antes de publicar payloads novos.
- Nao exponha token Slack nem `response_url`.
- Use `responseUrlId` quando precisar substituir/apagar a mensagem interativa
  original sem vazar `response_url`.
- Use `action_id` e `block_id` estaveis para automacoes.
- Prefira `blocks-update` para atualizar estado visual de uma mensagem existente.
