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
  superadmin authority mutation is DENIED.
- Enterprise mode ON, valid operator credential: the same check is ALLOWED and
  the resolved principal is `operator:<id>` in the scope context.
- `agentCan(undefined, …)` does NOT return allow purely from a missing
  `agentId`; it fails closed.
- A no-subject/no-context provider-runtime request is denied unless it
  explicitly requests local-operator authorization.
- Explicit local-operator authorization is exercised through the provider
  runtime facade and never through a hidden caller branch.
- A break-glass authority mutation records `operator:<id>` on the provider-owned
  audit event.
- A break-glass mutation with no auditable sink available is REFUSED (audit is a
  precondition, not best-effort).
- Recovery path: with every agent's `admin system:*` unavailable, an
  authenticated operator can still use the provider-owned recovery path; an
  unauthenticated caller cannot.
- A break-glass broad authority change above the blast-radius threshold without
  approval is REFUSED; with approval it succeeds and records operator + reason.

## Audit Assertions

- Every break-glass authorization emits a record with: `mode=break-glass`,
  `operator` principal, action, object, timestamp, reason, source.
- Delegated turns emit `actor` (not `operator`) and are never tagged
  `break-glass`.

## Doctor

- `ravi doctor` reports whether no-agent/no-context authorization is fail-closed
  and whether explicit local-operator authorization works.
- A check reports any privileged operator credential without an expiry as an
  informational finding (prefer time-bound operator privilege).

## Manual Security Review

- Attempt every authority-bearing gate (tool, Bash+executable, CLI group,
  session, contact, app, calendar, gateway, child-context) with no agent and no
  operator under enterprise mode; all MUST deny.
- Confirm no code path treats `!agentId` as allow without first resolving an
  operator in enterprise mode.
