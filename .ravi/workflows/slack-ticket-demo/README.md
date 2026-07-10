# Slack Ticket Demo

Este workflow e um exemplo de workspace, nao uma feature do core do Ravi.

Objetivo: provar que Block Kit + triggers shell + APIs locais do Ravi sao suficientes para
montar automacoes deterministicas fora de `src/`.

## Fluxo

1. Uma mensagem fixa em `#ravi-tickets` mostra apenas `Abrir ticket`.
2. O clique publica `ravi.inbound.interaction`.
3. O trigger shell roda `handler.ts`.
4. O handler envia um Block Kit ephemeral para o usuario escolher o tipo.
5. A escolha publica outro `ravi.inbound.interaction`.
6. O handler cria um canal Slack dedicado.
7. O handler convida o solicitante.
8. O handler publica uma mensagem Block Kit inicial dentro do canal do ticket.
9. O handler registra o ticket em `state/tickets.json`.
10. O handler cria uma route Ravi para um agent predefinido via API local.
11. O handler substitui a ephemeral do seletor por uma confirmacao com botao
    para abrir o canal.
12. A mensagem inicial do canal permite fechar o ticket ou arquivar o canal.

## Limite Atual

Este exemplo chama `chat.postEphemeral`, `chat.postMessage`, `chat.update` e
`conversations.archive` dentro do workflow, usando a credencial Slack resolvida
pelo broker. Isso valida a UX sem adicionar fluxo de tickets ao core.

O evento de interacao nativo nao expoe `response_url`. Ele publica
`responseUrlPresent` e, quando existe resposta interativa, `responseUrlId`.
Esse ID e um handle opaco para o broker nativo responder a interacao sem vazar
a URL bruta no payload do trigger.

A selecao do tipo e idempotente por `user + channel + messageTs`. Se o mesmo
evento for reprocessado, o workflow reutiliza o ticket existente e nao cria um
segundo canal.

Fallback atual: se o evento real nao trouxer `responseUrlId`, o workflow ainda
envia uma nova confirmacao ephemeral. Nesse caso a mensagem de escolha antiga
permanece visivel ate o Slack descartá-la. O diagnostico esperado e verificar se
o payload Socket Mode trouxe `response_url`; sem ele, `chat.update` retorna
`message_not_found` para ephemeral.

O produto final deve expor esses envios como primitives genericas de Ravi
Apps/workflows, nao como codigo hardcoded de tickets dentro do canal Slack.

## Publicar Card

```bash
bun .ravi/workflows/slack-ticket-demo/handler.ts seed C0BFPAJ7JB0
```

## Triggers

Use dois triggers. Um clique em `Abrir ticket` e a selecao do tipo sao dois
eventos em sequencia curta; se ficarem no mesmo trigger, o cooldown pode engolir
a segunda etapa.

```bash
ravi triggers add "Slack ticket workflow demo open" \
  --topic "ravi.inbound.interaction" \
  --filter 'data.provider == "slack" && data.interactionType == "block_actions" && data.channelId == "C0BFPAJ7JB0" && data.blockId startsWith "ravi_ticket_" && data.actionId == "ravi_ticket_open"' \
  --shell 'RAVI_TICKET_CREATE_ROUTE=1 RAVI_TICKET_DEFAULT_AGENT=ravi-channels-migration bun .ravi/workflows/slack-ticket-demo/handler.ts' \
  --timeout 30 \
  --cooldown 1s \
  --on-error notify-session:ravi-channels

ravi triggers add "Slack ticket workflow demo actions" \
  --topic "ravi.inbound.interaction" \
  --filter '(data.provider == "slack" && data.interactionType == "block_actions" && data.channelId == "C0BFPAJ7JB0" && data.blockId startsWith "ravi_ticket_" && data.actionId != "ravi_ticket_open") || (data.provider == "slack" && data.interactionType == "block_actions" && data.blockId == "ravi_ticket_channel_actions" && (data.actionId == "ravi_ticket_close" || data.actionId == "ravi_ticket_archive"))' \
  --shell 'RAVI_TICKET_CREATE_ROUTE=1 RAVI_TICKET_DEFAULT_AGENT=ravi-channels-migration bun .ravi/workflows/slack-ticket-demo/handler.ts' \
  --timeout 30 \
  --cooldown 1s \
  --on-error notify-session:ravi-channels
```

## Config

- `RAVI_TICKET_SLACK_CHANNEL`: channel config Slack a usar quando o workflow rodar
  fora de um trigger Slack. Em trigger Slack, o workflow usa o account/source do
  evento. O channel precisa ter `credentialConnection` configurado.
- `RAVI_TICKET_DEFAULT_AGENT`: agent logico do ticket, default
  `ravi-channels-migration`.
- `RAVI_TICKET_CREATE_ROUTE=1`: cria route para o canal novo via router DB local.
- `RAVI_TICKET_ROUTE_SESSION_PREFIX`: prefixo de sessao para routes criadas,
  default `ravi-ticket`.
