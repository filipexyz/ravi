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
- Quando uma Slack thread cria uma nova sessao Ravi, o adapter emite
  `ravi.inbound.thread.created` uma unica vez para aquela sessao/thread.

## Evento

Use `ravi.inbound.thread.created` para bootstraps e automacoes que precisam
reagir ao nascimento de uma thread/sessao Slack.

Campos principais:

- `provider`: `slack`
- `channelId`: canal Slack
- `threadTs`: Slack `thread_ts`
- `messageTs`: mensagem que causou a criacao
- `canonicalChatId`: chat canonico Ravi da thread
- `sessionKey` / `sessionName`: sessao Ravi criada
- `agentId`: agent resolvido pela rota

O evento nao dispara em mensagens seguintes da mesma thread.

## Orquestracao

A sessao do canal (ou DM) orquestra as threads que abre com
`ravi sessions create-thread`. Ela lista as threads com
`ravi sessions threads --json` e manda instrucoes com
`ravi sessions thread-send <sessao-da-thread> "..."`. A thread avisa a sessao do
canal com `ravi sessions report "..."` sem fechar e termina com
`ravi sessions close-thread [--return "..."]`. Progresso e resultado chegam como
`[System] Inform: Slack thread "<titulo>" (<sessao-da-thread>) ...`.

Follow-up no canal sobre o assunto de uma thread aberta vai para ela com
`thread-send`, sem abrir outra. Threads nao falam entre si: a thread pede com
`report` e a sessao do canal repassa com `thread-send`.

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
