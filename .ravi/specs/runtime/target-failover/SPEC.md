# Runtime target failover

## Objective

Add a core-owned, provider-neutral policy that selects a complete runtime
target for each logical turn and deterministically advances after eligible
failures without duplicating unsafe work.

## Runtime target

A target contains a stable id, runtime provider, opaque model selector,
effort/thinking options, credential scope, required capabilities and session
compatibility metadata. Core never assigns a universal provider order.

## State machine

`select target -> select credential -> launch attempt -> success | recover
credential | retry target | switch target | terminal exhaustion`

## Invariants

- Adapters execute exactly one resolved target and never invent fallback.
- Credential recovery and target switching are distinct transitions.
- Request, safety, schema, permission and malformed-prompt failures terminate.
- Replay terminates after any unsafe tool or side-effect boundary.
- A switch never resumes incompatible provider session state.
- Provider registration, capabilities and effective permissions are preflighted.
- Cooldown, open-circuit state and attempt budgets are deterministic.
- One logical turn emits at most one final user-facing response.
- Diagnostics and persisted state contain ids and failure classes, not secrets.

## Policy scopes and precedence

`session override > task profile > agent defaults > no failover`.

Each effective policy response exposes its value, source and provenance. An
empty policy means the current single-target behavior remains unchanged.

## Persistence

Attempt transitions must be durable before a replay or target switch begins.
Restart reconstructs the logical turn, attempted targets, side-effect boundary
and terminal status without returning to an already failed target.
