---
id: channels
title: Channels
kind: domain
domain: channels
capabilities:
tags:
  - omni
  - gateway
applies_to:
  - src/gateway.ts
  - src/omni/
owners:
  - dev
status: active
normative: true
---

# Channels

## Intent

Channel behavior protects the boundary between Ravi runtime decisions and transport delivery.

## Invariants

- Ravi MUST own operational behavior such as routing, presence lifecycle, task notifications, and runtime-originated outbound intent.
- Transport adapters MUST only deliver channel-specific payloads and report delivery state.
- Ravi MUST NOT patch transport code to compensate for broken runtime lifecycle or routing rules without evidence that the transport contract is wrong.

## Validation

- `bun test src/gateway-session-trace.test.ts src/gateway-typing.test.ts`

## Known Failure Modes

- Fixing channel symptoms in the transport layer when the root cause is in Ravi.
- Letting presence or outbound state leak between sessions that share an instance.
