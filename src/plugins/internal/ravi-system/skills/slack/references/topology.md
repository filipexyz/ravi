# Slack Topology

Use esta referencia quando a tarefa envolver ownership, rotas, sessoes,
diagnostico de canal, ou "qual agent responde neste canal/thread".

## Comandos

```bash
ravi slack topology --json
ravi routes list --json
ravi sessions list --json
ravi sessions trace <session>
```

## O Que Topology Deve Explicar

- Slack channel/DM/thread visivel ao bot.
- Ravi route explicita quando existir.
- Sessao ligada ao chat/thread.
- Agent que responde por default quando nao ha rota explicita.
- Inbound policy gates.

## Regras

- `chat` e container do canal; `session` e estado runtime do agent.
- Um chat pode alimentar varias sessoes; uma sessao pode estar inscrita em
  varios chats.
- Nao corrija roteamento criando outra route por cima de chat ja atachado em
  sessao errada. Primeiro entenda a subscription/session binding.

## Specs

```bash
ravi specs get channels/slack/topology --mode full --json
ravi specs get channels/model --mode rules --json
```
