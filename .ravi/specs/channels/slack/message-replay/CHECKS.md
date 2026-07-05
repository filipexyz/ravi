---
id: channels/slack/message-replay/checks
title: "Slack Message Inspect And Replay Checks"
kind: checks
domain: channels
capability: slack
feature: message-replay
status: active
normative: true
---

# Slack Message Inspect And Replay Checks

- `messages-inspect` MUST return whether the Slack message exists in Slack.
- `messages-inspect` MUST return whether the Slack message exists in Ravi's local message ledger.
- `messages-inspect` MUST NOT expose Slack private download URLs or token-bearing data.
- `messages-replay` MUST be dry-run unless `--execute` is provided.
- `messages-replay` MUST refuse duplicate replay when the message already exists locally unless `--force` is provided.
- Executed replay MUST route through the same Slack Socket Mode handler used by live ingestion.
- Executed replay MUST preserve identity, media, transcription and routing behavior.
