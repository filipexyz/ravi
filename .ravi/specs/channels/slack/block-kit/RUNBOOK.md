# Runbook

## Validar payload

```bash
ravi slack blocks-validate ./block-kit.json --json
```

Targets aceitos:

```bash
ravi slack blocks-validate ./blocks.json --target blocks --json
ravi slack blocks-validate ./message.json --target message --json
ravi slack blocks-validate ./view.json --target view --json
```

## Enviar mensagem

```bash
ravi slack blocks-send C123 ./message.json --execute --json
```

Se o arquivo for um array de blocks, forneca fallback:

```bash
ravi slack blocks-send C123 ./blocks.json --text "Resumo acessivel" --execute --json
```

## Atualizar mensagem existente

```bash
ravi slack blocks-update C123 1713000000.000100 ./message.json --execute --json
```

## Showcase

```bash
ravi slack blocks-showcase C123 --execute --json
```

## Interacoes

Depois de clicar em um botao/select, inspecione eventos:

```bash
ravi triggers topics --json
```

O evento esperado e `ravi.inbound.interaction`.

## Trigger shell deterministico

Criar trigger para fluxo de tickets:

```bash
ravi triggers add "Slack ticket flow" \
  --topic "ravi.inbound.interaction" \
  --filter 'data.provider == "slack" && data.interactionType == "block_actions" && data.blockId startsWith "ravi_ticket_"' \
  --shell 'bun scripts/slack-ticket-flow.ts' \
  --timeout 30 \
  --on-error notify-session:ravi-channels
```

Enviar card inicial de teste:

```bash
bun scripts/slack-ticket-flow.ts seed C0BG33ZUWJC
```

O script grava state em:

```text
.ravi/state/slack-ticket-flow/tickets.json
```

Fluxo esperado:

1. clicar em `Criar ticket`;
2. mensagem vira ticket aberto com select de agent;
3. escolher agent;
4. mensagem vira select de sessao;
5. escolher sessao;
6. mensagem mostra ticket roteado.
