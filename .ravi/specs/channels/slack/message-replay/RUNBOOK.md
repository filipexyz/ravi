---
id: channels/slack/message-replay/runbook
title: "Slack Message Inspect And Replay Runbook"
kind: runbook
domain: channels
capability: slack
feature: message-replay
status: active
normative: true
---

# Slack Message Replay Runbook

## Inspect

```bash
ravi slack messages-inspect C123 1783266325.132679 --channel ravi-rbbt-slack --json
```

Use quando precisar diferenciar:

- mensagem não existe no Slack;
- mensagem existe no Slack, mas não entrou no Ravi;
- mensagem já foi ingerida no ledger local.

## Replay

Dry-run:

```bash
ravi slack messages-replay C123 1783266325.132679 --channel ravi-rbbt-slack --json
```

Executar:

```bash
ravi slack messages-replay C123 1783266325.132679 --channel ravi-rbbt-slack --execute --json
```

Forçar duplicata operacional:

```bash
ravi slack messages-replay C123 1783266325.132679 --channel ravi-rbbt-slack --force --execute --json
```

## Critérios

- O retorno não pode conter token nem URL privada de arquivo.
- O replay deve produzir o mesmo tipo de prompt que Socket Mode produziria.
- Se houver áudio, a transcrição deve passar pelo provider normal de mídia.
