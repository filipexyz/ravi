# Slack Messages And Replay

Use esta referencia para envio, leitura, inspecao ou replay de mensagens Slack.

## Comandos

```bash
ravi slack messages-send <channel> "texto" --execute --json
ravi slack channels-history <channel> --json
ravi slack messages-inspect <channel> <ts> --json
ravi slack messages-replay <channel> <ts> --execute --json
```

## Quando Usar Replay

Use `messages-replay` quando uma mensagem Slack chegou na plataforma, mas parece
nao ter produzido turno, delivery ou resposta no Ravi.

Fluxo recomendado:

1. Inspecionar a mensagem:
   ```bash
   ravi slack messages-inspect <channel> <ts> --json
   ```
2. Se a mensagem existe e o replay for seguro, executar:
   ```bash
   ravi slack messages-replay <channel> <ts> --execute --json
   ```
3. Conferir trace da sessao quando o replay nao produzir terminal state:
   ```bash
   ravi sessions trace <session>
   ```

## Regras

- `messages-send` e `messages-replay` sao mutacoes; use `--execute`.
- Nao fazer replay em loop sem entender idempotencia e efeito externo.
- Para audio/file_share, confirme que o arquivo foi ingerido e associado ao
  actor correto antes de reexecutar.

## Specs

```bash
ravi specs get channels/slack/message-replay --mode full --json
ravi specs get channels/messages --mode rules --json
```
