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

- Every new provider dispatch MUST issue a `turn-runtime` context with
  `metadata.authorityMode=agent-identity`.
- Dispatch MUST NOT create or reuse `agent-runtime` contexts for active
  authorization.
- The runtime context MUST be scoped to the invocation and must carry the
  executor agent, session key, actor resolution, compartment, source metadata,
  materialized capabilities, and provenance needed for audit.
- External inbound turns with unresolved human actor identity MUST fail closed
  by materializing no tool/executable/CLI/session authority.
- Internal or local prompts without an external source MAY use the workspace
  compartment `agent_identity:<agent-id>:workspace:default`.
- Child contexts issued from a `turn-runtime` context MUST remain derived
  credentials and MUST NOT bypass `resolveRuntimeContext`.
- Daemon bootstrap admin detection MUST only consider `admin-bootstrap`
  contexts. Agent identity turn contexts that happen to snapshot
  `admin:system:*` MUST NOT count as bootstrap admin credentials.
- Any live `agent-runtime` context is historical residue and MUST be reported
  by production-readiness checks until revoked, expired, or migrated.
- Bulk cleanup of historical `agent-runtime` contexts MUST be opt-in and
  exposed through an explicit CLI path. It MUST NOT run automatically during
  dispatch or daemon startup.

## Acceptance

- Ten turns in the same session create ten independently auditable
  `turn-runtime` records or equivalent invocation-scoped overlays.
- Every new dispatch context has `authorityMode=agent-identity`; none has
  `kind=agent-runtime`.
- Reset or abort revokes live runtime contexts for the session and the next
  dispatch issues a fresh agent-identity context.
- Stale historical contexts can be inspected in dry-run mode before any revoke.
