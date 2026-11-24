---
id: sessions/observe
title: Session Observe
kind: capability
domain: sessions
capability: observe
tags:
  - sessions
  - observers
  - orchestration
applies_to:
  - src/cli/commands/sessions.ts
  - src/runtime/observation-plane.ts
  - src/runtime/observation-conditions.ts
  - src/runtime/observation-profiles.ts
  - src/runtime/host-event-loop.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Session Observe

## Intent

Let a session watch another one cheaply. `ravi sessions observe <source>` makes the current session (or `--to <session>`) get a short notice when a finished turn of `<source>` goes wrong, or a short summary of every turn with `--follow`. It is the one-command form of an Observation Plane rule; it never runs a model to decide whether to notify.

## Commands

- `ravi sessions observe <source> [--to <session>] [--when <c1,c2>] [--follow] [--json]`
- `ravi sessions unobserve <source> [--to <session>] [--json]`
- `ravi sessions observing [--json]`

## Contract

- `observe` MUST resolve both sessions with the same scope check as any session target: a session the caller cannot reach is reported as not found, on either end.
- The notices run as a turn of the receiving session's agent, so that agent MUST be the caller's own or one the caller may mutate.
- A session MUST NOT observe itself, and a trigger's own session MUST NOT be a receiver (it only takes its trigger's fires).
- A trigger's own session, or any session whose history holds what a turn read with its trigger owner's authority (`sessionHoldsTriggerOwnerHistory`), MUST NOT be the source of a live receiver: such a session answers no chat, and forwarding its turns to a conversation would be that answer. `observe` refuses it, every rule write with `metadata.deliverTo` refuses it (operator included), and every delivery re-checks it, because the owner-read mark is written on the trigger's first fire, which can come after the rule exists.
- Authority over the receiver is checked when the rule is written (by `observe` or `observers rules set`), as the caller at that moment; a delivery does not re-evaluate the creator's scope.
- Both ends are stored by session key: a rename keeps the observation, and a name later reused by another session MUST NOT receive its notices.
- Flag misuse (`--follow` with `--when`) and unknown condition names MUST fail as usage errors (exit 2).
- `observe` creates or overwrites one rule per (receiver, source) pair, id `observe:<hash of both session keys>`, session-scoped, profile `compact`, delivery `end_of_turn`, mode `observe`, no permission grants. Running it again changes the mode in place; it never creates a second rule.
- The binding MUST be attached at once, so a running source session is observed without relaunching.
- Without `--follow`, the rule carries `metadata.when` (default `turn.no_final_reply`, `chat.narration`, `turn.failed`, `tool.idle`); `--when` replaces the list and unknown names fail. `--follow` and `--when` are exclusive.
- Delivery goes to the receiving session as a normal `[System] Inform: [from: ravi observer] …` prompt, marked `_observationNotice` (an isolated envelope: never batched with another prompt into one turn, never joined by held `!!` text; the cost is one receiver turn per notice, which matters only with `--follow` on a busy source), not as an `_observation` prompt: the notice turn is observer-originated, so it emits no observation events (two sessions watching each other cannot loop); the receiver is a live conversation, not an isolated observer session, and an `_observation` prompt would start a second runtime beside it.
- `unobserve` deletes the rule; deleting a rule disables its binding in the same transaction.
- `observing` lists active `observe:` rules whose both ends the caller can reach.
- The command is channel-free: the receiver's own delivery path decides where its reply goes.

## Out of scope

- `handoff.*` conditions (the handoff reconciler is the one that reminds; a consumer comes later if a case is left uncovered).
- A pull summary (`--summary`); `ravi sessions recap` covers reading a session on demand.
