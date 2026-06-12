---
id: permissions/enterprise/break-glass/checks
title: "Authenticated Break-Glass Checks"
kind: checks
domain: permissions
capability: enterprise
feature: break-glass
---

# Authenticated Break-Glass Checks

## Unit / Integration Tests

- Enterprise mode ON, no agent principal, no operator credential:
  `enforceScopeCheck("superadmin", "permissions", "grant")` is DENIED.
- Enterprise mode ON, valid operator credential: the same check is ALLOWED and
  the resolved principal is `operator:<id>` in the scope context.
- Enterprise mode ON: `agentCan(undefined, …)` does NOT return allow purely from
  a missing `agentId`; it requires a resolved operator.
- Enterprise mode OFF (compatibility): the legacy no-agentId allow path still
  works (one explicit regression test pinning the legacy behavior).
- A break-glass `permissions grant` records `issued_by = operator:<id>` on the
  created relation.
- A break-glass mutation with no auditable sink available is REFUSED (audit is a
  precondition, not best-effort).
- Recovery path: with every agent's `admin system:*` revoked, an authenticated
  operator can still `restore-batch`/`grant`; an unauthenticated caller cannot.
- A break-glass bulk revocation above the blast-radius threshold without
  approval is REFUSED; with approval it succeeds and records operator + reason.

## Audit Assertions

- Every break-glass authorization emits a record with: `mode=break-glass`,
  `operator` principal, action, object, timestamp, reason, source.
- Delegated turns emit `actor` (not `operator`) and are never tagged
  `break-glass`.

## Doctor

- `ravi doctor` reports whether the unauthenticated no-agentId bypass is active
  (enterprise mode off) as a warning in enterprise contexts.
- A check reports any privileged operator credential without an expiry as an
  informational finding (prefer time-bound operator privilege).

## Manual Security Review

- Attempt every authority-bearing gate (tool, Bash+executable, CLI group,
  session, contact, app, calendar, gateway, child-context) with no agent and no
  operator under enterprise mode; all MUST deny.
- Confirm no code path treats `!agentId` as allow without first resolving an
  operator in enterprise mode.
