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
- Terminal runtime events MUST stop presence. Runtime `status=idle` is terminal for presence cleanup even when a provider omits or delays `turn.complete`/`turn.completed`.
- Late stream/runtime activity MUST NOT reactivate an ended turn.
- A new turn start MAY reactivate presence.
- Low-level provider passthrough events such as `provider.raw` MUST NOT start or renew presence unless they are normalized into a semantic runtime event.
- Background automation sources, including cron prompts that route replies through a chat/session, MUST suppress `typing=true` presence while the automation is working. The target MAY still receive a final response if the automation produces one.
- Non-final WhatsApp sends MAY renew presence after a short delay.
- Presence target matching MUST compare the physical transport target: normalized channel family, resolved Omni instance id, normalized chat JID, and thread id. Account-name targets and instance-id targets that resolve to the same Omni instance MUST be treated as the same target.
- Presence renewal MUST NOT fall back to a direct `typing=true` send when the active target is only an alias of the runtime event source.
- Presence cleanup MUST NOT send duplicate fallback pauses when the active target is only an alias of the terminal event source.
- Presence start, renew, stop, fallback, skip, and failure transitions MUST emit `ravi.presence.typing` and MUST be recorded as `presence.typing` in the session trace with `status`, `reason`, session name, and normalized target.
- Presence cleanup SHOULD await the active heartbeat stop instead of fire-and-forget cleanup when the caller is already in an async lifecycle path.

## Validation

- `bun test src/gateway-session-trace.test.ts`
- `bun test src/omni/typing-presence.test.ts`

## Known Failure Modes

- `@@SILENT@@` produces no text but leaves typing visible.
- Final outbound delivery schedules a delayed renewal.
- Runtime activity arrives after terminal state and reopens presence.
- Runtime/source events use an instance UUID while the active inbound heartbeat uses the account name, causing repeated presence sends for the same physical chat.
- No persisted presence trace exists, forcing operators to infer active typing from runtime events or PM2 logs.
