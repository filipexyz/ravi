---
id: channels/presence
title: Presence
kind: capability
domain: channels
capabilities:
  - presence
tags:
  - typing
  - gateway
applies_to:
  - src/gateway.ts
owners:
  - dev
status: active
normative: true
---

# Presence

## Intent

Presence should communicate real active work in the current session.

## Invariants

- Presence MUST be scoped to one session/channel target at a time.
- Presence MUST NOT make idle sessions look active.
- Presence renewal SHOULD be tied to runtime work, streaming, or non-final delivery activity.
- Presence MUST stop when the runtime has no active turn for that session.

## Validation

- `bun test src/gateway-session-trace.test.ts`

## Known Failure Modes

- Heartbeat or late stream events reactivating presence after a turn ended.
- Silent responses leaving typing active.
- Presence renewing across many chats on the same instance.
