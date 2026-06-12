---
id: permissions/enterprise/break-glass
title: "Authenticated Break-Glass"
kind: feature
domain: permissions
capability: enterprise
feature: break-glass
capabilities:
  - rebac
  - operator-identity
  - audit
tags:
  - permissions
  - enterprise
  - break-glass
  - security
applies_to:
  - src/permissions/scope.ts
  - src/permissions/engine.ts
  - src/cli/commands/permissions.ts
  - src/cli/registry.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Authenticated Break-Glass

## Intent

Today, the absence of an agent principal is treated as full authority:
`agentCan(undefined, …)` returns `true` and `enforceScopeCheck` allows
superadmin/admin scopes when `ctx.agentId` is unset (`engine.ts:153`,
`scope.ts`). This is the legitimate local-operator recovery path — and it is
also an unauthenticated god-mode bypass that a security review fails on.

Enterprise break-glass replaces "no principal ⇒ allowed" with an **explicit,
authenticated operator principal** whose every privileged action is recorded.
The capability to recover from an incident is preserved; the silent bypass is
removed.

## Definitions

- `operator`: an authenticated human or service principal acting outside any
  agent runtime context, e.g. `operator:<id>` or `system:<id>`.
- `break-glass`: a privileged action authorized by an operator rather than by
  delegated turn authority.
- `operator credential`: the proof of operator identity (local admin key, OS
  user binding, signed token, or future IdP-issued operator token).

## Invariants

- Absence of an agent principal MUST NOT, by itself, authorize an
  authority-bearing action. The legacy "no agentId ⇒ allow" path MUST be gated
  by an authenticated operator principal when enterprise mode is enabled.
- A break-glass authorization MUST resolve to a concrete `operator:<id>` or
  `system:<id>` principal. An unauthenticated caller MUST be denied (fail
  closed), not granted.
- Every break-glass authorization MUST emit a complete audit record (operator
  identity, action, object, timestamp, reason, source) to the tamper-evident
  audit log (see `permissions/enterprise/audit`). A break-glass action that
  cannot be audited MUST be refused.
- Break-glass MUST be distinguishable from normal delegated authority in traces
  and provenance (`mode = break-glass`, operator principal present).
- High-impact break-glass actions (bulk revocation, clearing relations, granting
  `admin system:*`, restoring batches) SHOULD require a reason and MAY require a
  second-operator approval or be time-bound; above a configured blast-radius
  threshold approval MUST be required (reuse the existing bulk-op blast-radius
  guard).
- Operator privilege MUST be revocable and time-bindable like any other grant;
  a standing all-powerful local operator is a configuration, not the default for
  enterprise mode.
- A compatibility mode MUST exist for the local single-operator developer
  workflow (`RAVI_ENTERPRISE_MODE` off ⇒ legacy local-operator bypass), but it
  MUST be OFF by default for enterprise deployments and its state MUST be
  visible in `ravi doctor`.

## Operator Resolution

- The runtime MUST resolve an operator principal from the operator credential
  before treating a no-agent invocation as authorized.
- Resolution order SHOULD be: explicit operator token/credential → bound OS/admin
  identity → (compatibility mode only) anonymous local operator.
- An invocation with no resolvable operator and no agent principal MUST be
  denied for authority-bearing actions, while non-authoritative read/help paths
  MAY remain available.
- The resolved operator principal MUST be carried in the scope/runtime context
  so downstream checks and audit see the same identity.

## Enforcement Changes

- `agentCan(undefined, …)` and `enforceScopeCheck` MUST consult the resolved
  operator principal instead of returning allow purely on missing `agentId`.
- The permission-mutating CLI group (`grant`, `init`, `revoke`, `legacy`,
  `restore-batch`, `prune-revoked`, `clear`) MUST require an authenticated
  operator in enterprise mode and MUST record the operator on each mutation
  (`issued_by = operator:<id>`).
- Recovery from an incident that revokes all agent admin MUST remain possible
  through the authenticated operator path (the operator does not depend on any
  agent holding `admin system:*`), preserving the break-glass guarantee from
  `permissions/RUNBOOK.md` while closing the unauthenticated hole.

## Acceptance Criteria

- With enterprise mode on, an invocation with no agent principal and no operator
  credential is DENIED for `permissions grant` and every authority-bearing gate.
- With a valid operator credential, the same invocation is ALLOWED and produces
  a break-glass audit record naming the operator.
- A break-glass bulk revocation above the blast-radius threshold requires
  approval and records operator + reason + blast radius.
- Traces and `ravi.audit.*` distinguish break-glass (operator) from delegated
  (actor) authority.
- With enterprise mode off, the legacy local-operator workflow still works and
  `ravi doctor` reports that the unauthenticated bypass is active.
