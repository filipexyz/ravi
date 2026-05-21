---
id: sessions
title: Sessions
kind: domain
domain: sessions
capabilities:
  - attach
tags:
  - sessions
  - runtime
  - chats
applies_to:
  - src/router/sessions.ts
  - src/router/router-db.ts
  - src/router/resolver.ts
  - src/omni/consumer.ts
  - src/runtime/host-event-loop.ts
  - src/cli/commands/sessions.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Sessions

## Intent

A Ravi session is the runtime container for one agent working on a stream of inputs. The `sessions` domain owns the canonical session model: how a session is created, how it persists across restarts, which chats feed into it, and which chat receives its outputs.

This domain is the semantic owner above:

- transport surfaces (channels, chats — see `channels/chats`);
- provider runtime state (resume/fork/replay — see `runtime/session-continuity`);
- visibility into live token/skill state (see `runtime/session-visibility`);
- portable subject context (see `threads`).

Those capabilities all *reference* a session, but they MUST NOT redefine what a session is.

## Boundary

Sessions own:

- session identity (`session_key`, `session_name`, `agent_id`, `cwd`);
- which chats can dispatch input into the session (attach);
- which chat receives output by default and which is currently focused (focus);
- last-source provenance for outbound delivery when no explicit focus is set;
- session lifecycle: create, rename, reset, delete, ephemeral TTL.

Sessions do NOT own:

- channel transport behavior (delegated to Omni adapters);
- chat membership of humans (owned by `channels/chats` and `chat_participants`);
- provider session state (owned by `runtime/session-continuity`);
- thread/subject context (owned by `threads`);
- identity resolution (owned by `contacts/identity-graph`).

## Definitions

- `session`: runtime container for one agent. Identified by a stable `session_key`. Has a canonical `session_name` for human reference.
- `session_chat_binding`: pre-existing one-to-one record stating "this session belongs to chat X" (see `channels/chats`). It records the *primary* / *origin* chat.
- `session_chat_subscription`: multi-input record stating "chat X is allowed to dispatch into session S". Introduced by `sessions/attach`. One session MAY have many.
- `session_focus`: runtime-mutable output target indicating which chat receives the next emitted response. Introduced by `sessions/attach`. Optional; defaults to the chat of the last received inbound.
- `session_participant`: runtime participation projection (see `contacts/identity-graph`). It is not a permission and not an attach record.
- `session_key`: durable composite identifier (see `src/router/session-key.ts`). MUST remain stable for the session's lifetime.

## Invariants

- A session MUST always belong to exactly one agent.
- A session MUST have a stable `session_key`. Renaming the canonical `session_name` MUST NOT rewrite `session_key`.
- A session MAY have one or more attached chats (see `sessions/attach`). The original `session_chat_bindings` row identifies the primary chat for legacy compatibility.
- A session MUST have at most one active focus at any time. Absence of focus means "respond on the same chat as the inbound that produced the turn".
- Output delivery MUST resolve a concrete target chat at emit time. The session MUST NOT emit to "ambient" without a resolved chat.
- Session reset MUST clear provider continuity state (per `runtime/session-continuity`) but MUST NOT silently drop attach subscriptions or focus configuration — those are part of routing/wiring, not provider state.
- Deletion of a session MUST cascade to delete its subscriptions and focus rows.

## Validation

- `bun test src/router/sessions.test.ts src/router/sessions.rename.test.ts src/router/commit-matched-route.test.ts`

## Known Failure Modes

- Confusing `session_key` identity with `session_name` (display) — leads to broken routing when a session is renamed.
- Treating `session_chat_bindings` as "the only chat" instead of "the primary chat" — blocks multi-input attach.
- Resolving output target from `sessions.last_to`/`last_channel`/`last_account_id` after attach lands — those fields are last-source memory, not focus.
- Letting threads, observers, or knowledge collapse into the session concept.
