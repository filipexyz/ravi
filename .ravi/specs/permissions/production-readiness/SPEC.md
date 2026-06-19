---
id: permissions/production-readiness
title: "Permissions Production Readiness"
kind: capability
domain: permissions
capability: production-readiness
capabilities:
  - provider-runtime
  - agent-runtime-permissions
  - contact-policy-permissions
  - delegation
  - resource-visibility
  - operations
  - testing
tags:
  - permissions
  - production-readiness
  - security
  - testing
  - operations
applies_to:
  - src/permissions/provider-runtime.ts
  - src/permissions/provider-registry.ts
  - src/permissions/agent-runtime-permissions-provider.ts
  - src/permissions/contact-policy-permissions-provider.ts
  - src/permissions/capability-context.ts
  - src/permissions/delegation.ts
  - src/permissions/scope.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/context-registry.ts
  - src/router/router-db.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permissions Production Readiness

## Intent

This spec defines the exit criteria for declaring the provider-runtime
permission system production ready. A criterion counts as met only when code and
automated checks prevent regression.

Readiness is judged against the live model: turn-scoped delegated authority is
computed from executor agent, actor, surface, and turn capabilities, with
surface inheritance, deny vetoes, role expansion, delegation overrides, and
provider-owned resource visibility.

## Readiness Gates

### G1 Model Correctness

- User-initiated delegated execution MUST require the executor-agent ceiling and
  the actor branch.
- A surface with no explicit allow, deny, or constraint for the same object MUST
  inherit the actor branch.
- Explicit surface deny MUST veto inheritance, overrides, and wildcards.
- Surface constraints MUST bound the surface to the expanded constraint
  capabilities.
- Delegation overrides MAY satisfy human actor/surface branches, but MUST NOT
  exceed the executor-agent ceiling.
- Automation and unresolved actors MUST NOT receive human delegation overrides.

Validation: `bun test src/permissions/delegation.test.ts`.

### G2 Provider Runtime Boundary

- Authorization call sites MUST go through `provider-runtime`.
- Runtime context creation MUST materialize capabilities through registered
  materializers.
- Direct imports of retired permission engines or direct capability evaluators
  from core runtime call sites MUST fail doctor/tests.
- Apps, CLI command access, Bash hooks, SDK gateway, sessions, contacts, agents,
  automations, and resource visibility MUST be covered by provider-runtime
  checks or by a bounded already-materialized context capability snapshot.

Validation:

- `bun test src/permissions/provider-runtime.test.ts`
- `ravi doctor --domain permissions --json`

### G3 Freshness And Revocation

- Provider-owned config changes MUST affect the next materialization without
  daemon restart.
- Context snapshot counts are audit metadata, not live authorization state.
- Turn approval caps MUST remain an upper bound that newer provider-owned config
  cannot exceed.

Validation:

- `bun test src/runtime/runtime-request-context.test.ts`
- `bun test src/runtime/context-registry.test.ts`

### G4 Resource Visibility Migration

- Existing agents MUST become visible to the default operator agent through
  provider-owned runtime config: `view agent:*`.
- New agents created inside a runtime context MUST grant creator visibility via
  provider-owned config: `view agent:<new-agent-id>`.
- WhatsApp group creation with `--create-agent` MUST apply the same creator
  visibility rule.
- `agents list/show` MUST filter by `view agent:<id>` and return a
  not-found-equivalent result for hidden agents.

Validation:

- `bun test src/permissions/provider-runtime.test.ts`
- `bun test src/cli/commands/agents.test.ts`
- `ravi doctor --domain permissions --json`

### G5 Operational Safety

- `ravi permissions` MUST be inspection-only for the active provider runtime.
- Mutating agent authority MUST go through provider-owned surfaces such as
  `ravi agents permissions`.
- Skills and specs MUST teach the provider-runtime surface, not removed command
  paths.
- Doctor MUST report active provider-runtime health and resource-visibility
  migration gaps.

Validation:

- `bun test src/cli/commands/permissions.test.ts`
- `rg` over source, skills, and permission specs for removed command paths.

## Exit Checklist

- [x] Delegation model has focused tests.
- [x] Runtime provider boundary has tests.
- [x] Agent visibility migration is provider-owned and idempotent.
- [x] Agent creation persists creator visibility when a runtime creator exists.
- [x] WhatsApp group agent creation persists creator visibility.
- [x] Permissions CLI exposes status/check/materialize only.
- [x] Skills describe the current provider-runtime model.
