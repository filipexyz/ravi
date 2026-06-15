---
id: permissions/enterprise/break-glass
title: "Authenticated Break-Glass"
kind: feature
domain: permissions
capability: enterprise
feature: break-glass
capabilities:
  - local-grants
  - operator-identity
  - audit
tags:
  - permissions
  - enterprise
  - break-glass
  - security
applies_to:
  - src/permissions/scope.ts
  - src/permissions/provider-runtime.ts
  - src/cli/commands/permissions.ts
  - src/cli/registry.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Authenticated Break-Glass

## Intent

Historically, the absence of an agent principal was treated as full authority:
`agentCan(undefined, …)` and scope checks could allow privileged paths when
`ctx.agentId` was unset. That silent local-operator recovery path was an
unauthenticated god-mode bypass. The provider-runtime baseline now fails closed
for missing principals; break-glass defines the authenticated replacement for
operator recovery.

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
  authority-bearing action. `agentCan(undefined, …)` MUST fail closed in all
  modes. Local-operator authorization MUST be an explicit provider-runtime
  request, not an implicit caller branch.
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
- A compatibility mode MAY exist for local single-operator development, but it
  MUST still route through an explicit local-operator provider and MUST be
  visible in `ravi doctor`. It MUST NOT revive hidden `!agentId` allow branches.

## Operator Resolution

- The runtime MUST resolve an operator principal from the operator credential
  before treating a no-agent invocation as authorized.
- Resolution order SHOULD be: explicit operator token/credential → bound OS/admin
  identity → explicit local-operator provider request for development/bootstrap
  only.
- An invocation with no resolvable operator and no agent principal MUST be
  denied for authority-bearing actions, while non-authoritative read/help paths
  MAY remain available.
- The resolved operator principal MUST be carried in the scope/runtime context
  so downstream checks and audit see the same identity.

## Enforcement Changes

- `agentCan(undefined, …)` MUST return deny. `enforceScopeCheck` and other
  no-agent gates MUST consult an explicit local-operator/operator path instead
  of returning allow purely on missing `agentId`.
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
- With enterprise mode off, any local-operator workflow still uses explicit
  local-operator authorization and `ravi doctor` verifies that no implicit
  no-principal bypass is active.
