# Runtime Context Keys Rationale

## Decision

`agent-runtime` context keys are session-scoped. A session receives one live context per `(agentId, sessionKey)` and reuses that context across turns until it is revoked or expires.

## Why Not Turn-Scoped

Turn-scoped issuance creates many active credentials for the same durable session. With the default seven-day TTL, every turn leaves an active `agent-runtime` record behind. Agents with broad REBAC grants also snapshot broad capabilities into each record, which makes operational inspection noisy and can confuse admin bootstrap checks if those checks treat all live admin-capable contexts the same.

The runtime already has a stable `dbSessionKey`. That key is the correct lifecycle boundary for provider env, tool context, audit attribution, and child CLI issuance.

## Capability Drift

Capabilities intentionally remain a snapshot from context issuance time. If REBAC changes mid-session, the active context does not drift. This matches child context semantics and avoids silent privilege changes while a provider session is alive.

To force a new snapshot, revoke or reset the session context. The next dispatch creates a fresh `agent-runtime` context.

## Metadata Drift

Runtime metadata can change turn to turn: model override, effort, thinking, provider, source, and approval source. Reusing the context while refreshing metadata keeps the key stable for tools and audit while preserving the latest operational state for inspection.

## Lifecycle

Session reset and runtime abort are the explicit lifecycle boundaries for forcing a new session snapshot. Cleanup of old turn-scoped records is an operator action, not a daemon side effect.
