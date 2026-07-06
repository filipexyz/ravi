# Slack Credentials And Scopes

Use esta referencia para diagnosticar credenciais, scopes, connections e
permissoes Slack.

## Comandos

```bash
ravi slack permissions-list --json
ravi credentials connections list --json
```

## Regras

- Nao exiba token Slack bruto (`xox`, `xapp`) em resposta, log ou spec.
- O CLI comum deve trabalhar com connection/secret ref, nao com segredo.
- Se scopes foram alterados no app Slack, o app precisa ser reinstalado e a
  connection deve apontar para o token atualizado.
- Falta de credencial deve desabilitar adapter/operacao de forma fechada, nao
  cair em token desconhecido.
- Env fallback so deve ser usado quando houver opt-in explicito.

## Specs

```bash
ravi specs get channels/credentials --mode full --json
ravi specs get channels/adapters/slack --mode rules --json
```
