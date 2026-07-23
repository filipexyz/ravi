---
id: channels/slack/message-replay/why
title: "Why Slack Message Inspect And Replay"
kind: why
domain: channels
capability: slack
feature: message-replay
status: active
normative: true
---

# Why Slack Message Inspect And Replay

Native Slack ingestion can miss a message when Socket Mode is disconnected, a runner starts without the selected Slack connection, or a file event fails before reaching Ravi's durable ledger.

Operators need a deterministic way to answer two questions:

- did Slack receive the message?
- did Ravi ingest and dispatch the message?

Inspect and replay make that path auditable without manually reconstructing prompts or bypassing identity, media, routing and session semantics.
