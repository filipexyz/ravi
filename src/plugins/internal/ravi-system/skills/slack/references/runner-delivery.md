# Slack Runner And Delivery

Use esta referencia para problemas de envio, delivery, outbound job, idempotencia
ou runner Slack.

## Regras

- Runtime response destinada a Slack deve virar delivery job duravel antes do
  send na plataforma.
- O runner Slack consome jobs e chama o adapter nativo.
- Delivery job deve ter idempotency key estavel.
- Infraestrutura `CHANNEL_OUTBOUND` deve ser criada/verificada uma vez por
  processo e reutilizada depois de sucesso.
- Runner so deve ackar job depois de estado terminal ou delivery persistido.
- Ambiguous timeout nao deve gerar retry cego se a plataforma pode ter aceitado
  o send sem garantia de idempotencia.

## Diagnostico

```bash
ravi channels status --json
ravi channels probe --json
ravi sessions trace <session>
```

## Specs

```bash
ravi specs get channels/delivery --mode full --json
ravi specs get channels/runner --mode full --json
```
