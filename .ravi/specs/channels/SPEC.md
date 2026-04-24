---
id: channels
title: Channels
kind: domain
domain: channels
capabilities:
  - chats
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

Ravi MUST abstract Omni as a transport/gateway adapter. Product and agent-facing code SHOULD work with Ravi concepts such as contact, platform identity, chat, session, actor, message, route, and policy instead of raw provider ids.

## Invariants

- Ravi MUST own operational behavior such as routing, presence lifecycle, task notifications, and runtime-originated outbound intent.
- Transport adapters MUST only deliver channel-specific payloads and report delivery state.
- Ravi MUST NOT patch transport code to compensate for broken runtime lifecycle or routing rules without evidence that the transport contract is wrong.
- Omni/raw channel identifiers MUST remain stored as provenance and debugging data, but they MUST NOT be the primary product model exposed to agents or operators.
- Channel-specific behavior SHOULD be exposed to Ravi through typed capabilities and normalized events when a feature needs it, not through provider conditionals spread across features.
- A dedicated channel capability registry MAY be deferred until a concrete feature needs it. The source of capability facts SHOULD be Omni.

## Boundary

Omni owns transport:

- receiving raw channel events
- sending channel payloads
- mapping provider delivery state
- exposing native channel ids, message ids, participants, attachments, and delivery errors

Ravi owns semantics:

- identity resolution
- contacts and agents
- chats and sessions
- routing and policies
- presence lifecycle decisions
- calls, tasks, artifacts, triggers, and outbound intent
- event/audit shape consumed by agents and UI

Feature code SHOULD depend on the Ravi semantic layer first. Direct Omni access is allowed only inside channel adapters, diagnostics, migration, and low-level debugging paths.

## Validation

- `bun test src/gateway-session-trace.test.ts src/gateway-typing.test.ts`

## Known Failure Modes

- Fixing channel symptoms in the transport layer when the root cause is in Ravi.
- Letting presence or outbound state leak between sessions that share an instance.
- Letting feature code depend on WhatsApp LID, group JID, Telegram id, or other raw channel ids when a Ravi contact/chat/session/actor abstraction should be used.
- Dropping raw provider ids entirely and losing the provenance needed to debug transport failures.
