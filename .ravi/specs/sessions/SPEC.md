---
id: sessions
title: Sessions
kind: domain
domain: sessions
capabilities:
  - attach
  - visibility
  - rebac
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
- which chat receives the session's external output (attach);
- last-source provenance for trace/correlation;
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
- `session_chat_subscription`: record stating "chat X is wired to session S". Introduced by `sessions/attach`. One session MAY have many. One active subscription MAY be marked as the output attachment.
- `session_participant`: runtime participation projection (see `contacts/identity-graph`). It is not a permission and not an attach record.
- `session_key`: durable composite identifier (see `src/router/session-key.ts`). MUST remain stable for the session's lifetime.

## Invariants

- A session MUST always belong to exactly one agent.
- A session MUST have a stable `session_key`. Renaming the canonical `session_name` MUST NOT rewrite `session_key`.
- A session MAY have one or more attached chats (see `sessions/attach`). Each active subscription has an independent speech mode: `speak` or `muted`. The original `session_chat_bindings` row identifies the primary chat for legacy compatibility.
- A session MUST have at most one default attached output chat. Output delivery MUST prefer the current source chat when its subscription has `speech=speak`; otherwise it MUST resolve to the default output attachment when that subscription has `speech=speak`. The inbound source chat MUST NOT be used as an implicit output fallback when it is not an active speak-enabled subscription.
- If a response has neither a speak-enabled source subscription nor a speak-enabled default output attachment, it MUST NOT emit externally.
- `ravi sessions send` and related inter-session commands inject prompt/context into a Ravi session. They MUST NOT be documented as direct external channel delivery primitives. Visible outbound channel delivery belongs to the session response path or to explicit channel/media/outbound commands.
- Session reset MUST clear provider continuity state (per `runtime/session-continuity`) but MUST NOT silently drop attach subscriptions — those are routing/wiring, not provider state.
- Deletion of a session MUST cascade to delete its subscriptions.
- Session visibility is authorization-bearing. Runtime principals MUST only
  list, inspect, read, trace, or mutate sessions they own or have explicit
  grants for.
- `access session:<id>` authorizes session discovery/read/trace beyond the
  current own session.
- `modify session:<id>` authorizes session mutation beyond the current own
  session.
- A chat attached to a session is not by itself permission to read or mutate
  that session.
- Hidden sessions SHOULD appear missing on direct lookup.

## Validation

- `bun test src/router/sessions.test.ts src/router/sessions.rename.test.ts src/router/commit-matched-route.test.ts`
- Scope tests SHOULD cover `sessions list/info/read/trace` filtering through
  `access session:<id>` and mutation through `modify session:<id>`.

## Known Failure Modes

- Confusing `session_key` identity with `session_name` (display) — leads to broken routing when a session is renamed.
- Treating `session_chat_bindings` as "the only chat" instead of "the primary chat" — blocks multi-input attach.
- Reintroducing `focus` as a separate primitive instead of using `attach` as the output attachment.
- Falling back to inbound source for output after attach lands — causes sessions to reply in the wrong chat.
- Letting threads, observers, or knowledge collapse into the session concept.
