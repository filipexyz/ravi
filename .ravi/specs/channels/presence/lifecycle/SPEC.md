---
id: channels/presence/lifecycle
title: Presence Lifecycle
kind: feature
domain: channels
capabilities:
  - presence
  - runtime-lifecycle
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

# Presence Lifecycle

## Intent

Presence should show that Ravi is actively working, and it should disappear quickly when that work ends.

## Invariants

- Silent responses MUST stop presence immediately.
- Terminal runtime events MUST stop presence.
- Late stream/runtime activity MUST NOT reactivate an ended turn.
- A new turn start MAY reactivate presence.
- Non-final WhatsApp sends MAY renew presence after a short delay.

## Validation

- `bun test src/gateway-session-trace.test.ts`

## Known Failure Modes

- `@@SILENT@@` produces no text but leaves typing visible.
- Final outbound delivery schedules a delayed renewal.
- Runtime activity arrives after terminal state and reopens presence.
