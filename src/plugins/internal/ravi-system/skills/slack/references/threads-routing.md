# Slack Threads And Session Forks

Use esta referencia quando uma Slack thread deve criar ou retomar uma sessao
separada da conversa principal.

## Regras

- Uma resposta em Slack thread deve resolver `source.threadId` como o `thread_ts`
  inbound.
- Thread com `route.session` deve gerar fork a partir da sessao forçada.
- Se a sessao pai forçada ainda nao existir, a thread ainda deve usar chave
  derivada da sessao forçada, nao a chave computada do agent default.
- O child session deve herdar o contexto/permissoes adequados do parent, mas
  manter estado runtime separado.
- Outbound da child session deve voltar para a mesma Slack thread.

## Diagnostico

```bash
ravi slack topology --json
ravi sessions trace <child-session>
ravi routes list --json
```

## Testes Relacionados

```bash
bun test src/router/resolver.test.ts src/channels/slack/socket-mode.test.ts src/runtime/runtime-session-continuity.test.ts
```

## Specs

```bash
ravi specs get channels/slack/threads --mode full --json
```
