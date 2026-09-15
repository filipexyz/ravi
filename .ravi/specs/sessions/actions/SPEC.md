---
id: sessions/actions
title: "Session Actions"
kind: capability
domain: sessions
capabilities:
  - actions
  - chat-actions
  - own-messages
tags:
  - sessions
  - actions
  - channels
  - permissions
applies_to:
  - src/cli/context.ts
  - src/cli/commands/sessions.ts
  - src/router/router-db.ts
  - src/channels/chat-actions.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Session Actions

## Intent

`ravi sessions actions --json` is the canonical projection of conversational
actions for one runtime session.

## Catalog Contract

The payload MUST expose:

- schema version;
- session identity;
- concrete chat surfaces;
- effective surface when one can be resolved;
- stable action ids and discovery status;
- per-surface availability and reason codes;
- recent own outbound messages;
- command-specific prompt and target hints.

Flat action status MUST describe whether at least one listed surface can
execute the action. `availabilityBySurface` MUST preserve differences between
attached channels.

`session.read` and `session.recap` are session actions and are independent of
channel capabilities.
Conceptually useful actions without an executable command MUST be `planned`.

`thread.create` and `thread.close` are stable session action ids.
`thread.create` MUST expose a runnable `sessions create-thread` command only on
Slack and MUST accept an optional child model override. `thread.close` MUST
expose a runnable `sessions close-thread` command only for the current Slack
thread child. A return value on close explicitly opts into one parent
completion event.

## Own-Message Scope

Recent mutable messages MUST be constrained by:
- `actor_type=agent`;
- the session's agent id;
- a chat actively bound or subscribed to the session;
- the stable origin session key;
- non-deleted state.

An empty chat scope MUST return no rows. It MUST NOT omit the chat predicate and
fall back to all messages for the agent.

New outbound messages MUST persist `originSessionKey`. A legacy row without
provable origin MAY be visible in general history, but MUST NOT be offered as a
mutable session-action target.

Edit and delete lookup MUST apply the same scope as discovery.

Runtime source context MUST preserve the channel instance id and canonical chat
id when projecting into CLI tool context. Native action jobs MUST NOT discard
those identities when they already exist on the turn source.

## Authorization

- Session visibility and modification permissions MUST be evaluated before
  exposing or executing actions.
- Chat attachment alone is not session modification authority.
- An unavailable permission reason MUST remain non-sensitive.

## Compatibility

Existing stable action ids and command hints SHOULD remain compatible.
Additional per-surface fields are additive. Clients MUST prefer reason codes
over human-readable messages.
