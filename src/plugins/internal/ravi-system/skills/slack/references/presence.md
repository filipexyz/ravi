# Slack Presence And Runtime Status

Use esta referencia para status nativo do Slack, assistant status, typing,
presenca visivel e problemas de status preso/atrasado.

## Regras

- Runtime status e delivery state sao conceitos separados.
- Slack assistant status deve usar o Slack thread timestamp estavel, nao uma
  mensagem outbound movel como `thread_ts`.
- Status deve ser escopado por sessao + chat/thread.
- Cada sessao deve ter no maximo um status ativo por chat/thread.
- Ao terminar o turno, status deve limpar ou chegar a estado terminal.
- Fallback por reaction nao deve substituir o status nativo quando a capability
  nativa existe.

## Diagnostico

```bash
ravi sessions trace <session>
ravi slack messages-inspect <channel> <ts> --json
ravi slack topology --json
```

## Specs

```bash
ravi specs get channels/presence --mode full --json
ravi specs get channels/slack/presence --mode full --json
```
