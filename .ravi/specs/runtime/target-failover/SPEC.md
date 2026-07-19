---
id: runtime/target-failover
title: "Runtime Target Failover"
kind: capability
domain: runtime
capability: target-failover
capabilities:
  - runtime-target-selection
  - runtime-target-failover
  - credential-recovery
  - session-continuity
  - runtime-trace
tags:
  - runtime
  - providers
  - sessions
  - resilience
applies_to:
  - src/runtime/target-policy.ts
  - src/runtime/target-policy-config.ts
  - src/runtime/target-policy-trace.ts
  - src/runtime/session-resolver.ts
  - src/runtime/session-launcher.ts
  - src/runtime/host-event-loop.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime target failover

## Objective

Add a core-owned, provider-neutral policy that selects a complete runtime
target for each logical turn and deterministically advances after eligible
failures without re-executing unsafe work.

## Runtime target

A target contains a stable id plus either a reference to an enabled runtime
model preset or a direct runtime provider and opaque model selector. Preset
references are materialized into a versioned snapshot for a logical turn so a
mid-turn preset edit cannot change replay behavior. Optional effort/thinking,
required capabilities, and typed credential requirements constrain selection.
Core never assigns a universal provider order.

The policy does not own model or secret storage. `runtime presets` remains the
source of provider/model definitions, while `runtime credentials` remains the
source of credential ids, auth methods, compatibility keys, health, refresh,
and secret bindings. A target may only reference or constrain those existing
objects. Secrets never enter the policy, replay envelope, or trace.

## State machine

`select target -> select credential -> launch attempt -> success | recover
credential | retry target | switch target | terminal exhaustion`

## Invariants

- Adapters execute exactly one resolved target and never invent fallback.
- Credential recovery and target switching are distinct transitions.
- Request, safety, schema, permission and malformed-prompt failures terminate.
- Credential recovery requires structured provider evidence (HTTP status/code or an adapter-normalized credential scope); credential-like text and caught exceptions without that evidence terminate.
- Replay terminates after any unsafe tool or side-effect boundary.
- A switch never resumes incompatible provider session state.
- Provider registration, capabilities and effective permissions are preflighted.
- Cooldown, open-circuit state and attempt budgets are deterministic.
- One logical turn commits at most one terminal response event.
- Channel delivery remains at-least-once: a daemon crash after provider success
  and before the transport acknowledgement may redeliver that committed event.
  Provider-level exactly-once delivery is outside this policy's scope.
- Diagnostics and persisted state contain ids and failure classes, not secrets.
- Invalid effort, thinking, preset, and credential constraint values fail before launch.
- Configuration is channel-neutral; Slack, WhatsApp, Matrix, and TUI share the
  same dispatcher and target state machine.

## Policy scopes and precedence

`session override > task profile > agent defaults > no failover`.

Each effective policy response exposes its value, source and provenance. An
empty policy means the current single-target behavior remains unchanged.

Operators inspect the effective source, provenance, selected target, and
rejection reasons with `ravi runtime targets explain --agent <id> --json`.
Policy mutation must merge only `defaults.runtimeTargetPolicy`; it must never
replace unrelated agent defaults.

## Persistence

Attempt transitions must be durable before a replay or target switch begins.
Restart reconstructs the logical turn, attempted targets, side-effect boundary
and terminal status without returning to an already failed target. A committed
terminal response remains replayable until transport acknowledgement; replay is
at-least-once and may duplicate the physical channel message after a crash in
the acknowledgement window.

## Observability

Session Trace records target consideration, rejection, selection, credential
recovery, start failure, switch request, replay block, exhaustion, and success.
Model preset lineage is recorded as id/version and credential diagnostics are
redacted. A logical turn commits at most one terminal response event; transport
redelivery does not create a second logical response or rerun model/tool work.
