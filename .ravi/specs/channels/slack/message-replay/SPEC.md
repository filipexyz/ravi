---
id: channels/slack/message-replay
title: "Slack Message Inspect And Replay"
kind: feature
domain: channels
capability: slack
feature: message-replay
status: active
normative: true
---

# Slack Message Inspect And Replay

## Tese

O Ravi MUST conseguir auditar uma mensagem de canal por identificador externo e, quando ela não tiver entrado no runtime, fazer replay pelo mesmo pipeline nativo usado pelo adapter ao vivo.

## Contrato

- `inspect` MUST buscar a mensagem na plataforma e verificar se já existe no ledger canônico do Ravi.
- `inspect` MUST retornar apenas metadados seguros: canal, timestamp, tipo, usuário, tamanho do texto, anexos sem URLs privadas e estado local.
- `replay` MUST reconstruir um evento canônico e passar por parsing, routing, identidade, mídia, transcrição, persistência e `publishPrompt`.
- `replay` MUST ser dry-run por padrão e exigir `--execute`.
- `replay` MUST evitar duplicidade quando a mensagem já estiver no Ravi, exceto com `--force`.

## Primeiro Corte

O primeiro corte é Slack-only:

- `ravi slack messages-inspect <channel> <ts>`
- `ravi slack messages-replay <channel> <ts> --execute`

O contrato final SHOULD migrar para uma superfície genérica:

- `ravi channels messages inspect <channel> <message-id>`
- `ravi channels messages replay <channel> <message-id>`

## Não Escopo

- Replay de mensagens apagadas na plataforma.
- Replay multi-canal genérico.
- Replay automático sem confirmação operacional.
