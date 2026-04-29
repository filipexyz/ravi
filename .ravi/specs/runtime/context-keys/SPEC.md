---
id: runtime/context-keys
title: "Runtime Context Keys"
kind: capability
domain: runtime
capability: context-keys
tags:
  - runtime
  - context-keys
  - permissions
applies_to:
  - src/runtime/context-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/router/router-db.ts
  - src/cli/commands/context.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Context Keys

## Intent

Runtime context keys are opaque credentials that connect provider turns, Ravi tools, child CLIs, audit records, and capability checks to one durable Ravi runtime context.

## Rules

- `agent-runtime` contexts MUST be scoped to `(agentId, sessionKey)`, not to individual turns.
- A live `agent-runtime` context MUST be reused for later turns of the same `agentId + sessionKey`.
- Reusing an `agent-runtime` context MUST update `lastUsedAt` for every turn that receives the key.
- Reusing an `agent-runtime` context MAY refresh runtime metadata such as provider, model, effort, thinking, source, and approval source.
- Reusing an `agent-runtime` context MUST NOT recompute or replace `capabilities`; capabilities are a snapshot from issuance time.
- If the matching `agent-runtime` context is revoked or expired, the next dispatch MUST create a fresh context and take a new capability snapshot.
- `session reset` and runtime abort/reset paths SHOULD revoke the current live `agent-runtime` context for that session so the next dispatch takes a fresh snapshot.
- Child contexts issued from an `agent-runtime` context MUST remain derived credentials and MUST NOT bypass `resolveRuntimeContext`.
- Daemon bootstrap admin detection MUST only consider `admin-bootstrap` contexts. Agent runtime contexts that happen to snapshot `admin:system:*` MUST NOT count as bootstrap admin credentials.
- Bulk cleanup of historical `agent-runtime` contexts MUST be opt-in and exposed through an explicit CLI path. It MUST NOT run automatically during dispatch or daemon startup.

## Acceptance

- Ten turns in the same session create or reuse one live `agent-runtime` context.
- `lastUsedAt` changes across reused turns while `contextId`, `contextKey`, and `capabilities` stay stable.
- Reset or abort revokes the session context and causes a fresh context on the next dispatch.
- Stale historical contexts can be inspected in dry-run mode before any revoke.
