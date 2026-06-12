---
id: permissions/production-readiness
title: "Permissions Production Readiness"
kind: capability
domain: permissions
capability: production-readiness
capabilities:
  - rebac
  - delegation
  - explain
  - operations
  - testing
tags:
  - permissions
  - production-readiness
  - security
  - testing
  - operations
applies_to:
  - src/permissions/engine.ts
  - src/permissions/capability-context.ts
  - src/permissions/delegation.ts
  - src/permissions/scope.ts
  - src/permissions/explain.ts
  - src/permissions/policies.ts
  - src/permissions/relations.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/context-registry.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Permissions Production Readiness

## Intent

This spec defines the exit criteria for declaring the REBAC permission system
production ready. It is a gate, not a feature: each criterion is a `MUST` that
is either met or a tracked gap. A criterion counts as met only when it has an
automated check that fails if the property regresses.

Readiness is judged against the live model that exists today: turn-scoped
delegated authority computed as the intersection of executor agent, actor,
surface, and turn capabilities, with surface inheritance, deny vetoes, role
expansion, and delegation overrides. The system must be correct, consistent,
fresh, recoverable, observable, and tested before it carries production traffic
unsupervised.

## Readiness Gates

### G1 — Model Correctness

- Delegated authority MUST be an intersection of executor-agent, actor,
  surface, and turn capabilities. Union MUST NOT authorize user-initiated tool
  use.
- A surface with no explicit grant, `deny_<relation>`, or `constrain role:<id>`
  decision MUST inherit the actor branch and MUST NOT require a duplicate grant.
- `deny_<relation>` on any branch MUST veto the capability over every allow,
  inheritance, override, and wildcard.
- `constrain role:<id>` MUST bound the surface to the constraint role closure;
  capabilities outside it MUST deny unless a surface-level override allows them.
- Role membership MUST expand transitively with cycle protection on every
  branch.
- An unresolved or automation actor MUST receive no human delegation override.
- `admin system:*` on the executor agent MUST NOT, by itself, authorize a
  user-initiated delegated turn.

Validation: `bun test src/permissions/delegation.test.ts` (see G4) exercising
the full allow/deny/inherit/constrain/override matrix.

### G2 — Evaluator Consistency

The system contains more than one evaluation path: the live recursive engine
(`canInternal`), the snapshot matcher (`capabilitiesAllow`), the delegated
materializer (`buildEffectiveCapabilities`), and the explain branch matcher
(`relationCoversRequest`).

- The final delegated allow/deny used by enforcement and by `explain` MUST come
  from the same materializer (`materializeDelegatedAuthority`). A parallel
  implementation that can disagree on the final decision is forbidden.
- For any subject and effective grant set, the live engine and the
  snapshot/delegated path MUST agree on allow/deny across wildcards, trailing
  patterns, tool-group membership, nested roles, and constraints.
- Wildcard/pattern semantics MUST be defined in one place and shared. The
  current contract is exact match, full `*`, and trailing `prefix*` only;
  infix patterns are not supported and MUST NOT silently appear to match.
- A regression test MUST assert engine-vs-materializer agreement on a shared
  case matrix; drift MUST fail CI.

Validation: a cross-evaluator agreement test (currently missing) plus
`explain` final-decision equality against a real enforcement check.

### G3 — Freshness And Revocation

- A grant created after a delegated context was built MUST authorize on the
  next turn without daemon restart. (Met: enforcement live-materializes
  delegated authority.)
- A revoked grant, role membership, constraint, or policy MUST stop
  authorizing by the next authority check.
- Capability counts stored in context metadata MUST be treated as point-in-time
  snapshots, never as live state, by every consumer (denial diagnosis, explain,
  audit).
- Turn/observer approval caps MUST remain an upper bound that newer live grants
  cannot exceed.

Validation: freshness tests in
`permissions/delegation/turn-scoped-authority/CHECKS.md` plus a revoke→deny
test on a live context.

### G4 — Test Coverage Of The Core

- `delegation.ts` MUST have a dedicated unit test covering intersection,
  surface inheritance, deny veto, constraint bounding, role expansion (nested +
  cyclic), delegation overrides, and automation/unresolved-actor emptiness.
  (Gap: no `delegation.test.ts` today; logic is only exercised indirectly.)
- `capability-context.ts` MUST have a dedicated unit test for the snapshot
  matcher and the superadmin boundary across delegated vs agent-runtime
  contexts. (Gap: no `capability-context.test.ts` today.)
- The group-chat cross-actor regression (trusted speaker then untrusted speaker
  in one session) MUST be tested end to end.
- Automation principals (cron/trigger) MUST have tests proving they run under
  their own principal and do not inherit the last human actor.
- Coverage of authority-bearing gates (tools, Bash+executable, CLI groups,
  sessions, contacts, apps, gateway streams, child-context issuance) MUST each
  have at least one allow and one deny test.

Validation: presence and green status of the named test files; coverage report
on `src/permissions` and the enforcement gates.

### G5 — Operational Safety

- Bulk revocation (`permissions legacy --apply`) MUST simulate blast radius,
  refuse above the zero-capability threshold without `--break-glass`, detect
  self-preservation, and stamp a revocation batch id. (Met.)
- Every bulk revocation MUST be reversible as a unit through a relation-store
  API without hand SQL. (Met via `restore-batch`.)
- Subject-scoped restore MUST be a first-class CLI path; restoring one
  subject's revoked grants MUST NOT require raw SQL. (Gap: `restore-batch` is
  batch-wide only; subject-scoped recovery currently needs SQL.)
- A break-glass operator path to grant/restore permissions MUST exist that does
  not depend on any agent holding `admin system:*`, so an incident that revokes
  admin cannot lock out recovery. (Gap surfaced by the 2026-06-10 incident: the
  permission-managing agents lost admin and could not self-serve.)
- Destructive permission commands invoked from an agent runtime context MUST
  require human operator approval above the blast-radius threshold; agent
  self-confirmation MUST NOT clear the gate.

Validation: `permissions/profiles/CHECKS.md` legacy/restore checks plus a
subject-scoped restore test and a break-glass path test.

### G6 — Configuration Completeness

- A newly observed chat surface MUST resolve to a sane default without manual
  per-surface seeding. Inheritance covers the no-decision case; a documented
  default-surface profile MUST exist for the case where surfaces should be
  constrained by default.
- Every automation that drives an agent (cron, trigger, session-followup,
  daemon-restart) MUST resolve to a principal whose role grants cover what that
  automation needs. A reconcile/seed path MUST assign automation principals to
  the correct role rather than leaving them on a minimal base role.
- Agent role membership and per-agent least-privilege roles MUST be derivable
  from config/policy and reconciled on boot, not hand-maintained per subject.
- The legacy wildcard/full-access grants remaining on bootstrap/issuer subjects
  MUST be retired or explicitly re-justified; they MUST NOT remain as ambient
  debt.

Validation: a reconcile dry-run showing zero unintended drift, plus a check
that automation principals in use are covered by an active role.

### G7 — Explainability And Audit

- Every denial MUST carry a grant state (`never_granted`, `revoked`, `expired`,
  `constrained`, `ceiling`) and reference a revocation event when the blocking
  branch lost authority to a batch. (Met.)
- `permissions explain` MUST reproduce a persisted denial and report whether
  current state still denies. (Met.)
- For an allow, every effective capability MUST be attributable to a direct
  grant, role expansion, delegation override, or turn approval. (Met.)
- Audit events MUST never leak `contextKey`, secret env values, or credentials.

Validation: `permissions/explain/CHECKS.md`.

### G8 — State Hygiene

- Revoked relations MUST be retained for audit but MUST NOT unbounded-grow the
  hot table; an archival/compaction path SHOULD exist. (Today: ~16k revoked
  rows vs ~257 active.)
- Operator listing MUST be able to include inactive grants without
  reactivating them. (Met.)
- A health check MUST report subjects with zero active capabilities, broad
  `admin system:*` contexts, and the revoked-relation backlog. (Met:
  `permissions.rebac_zero_capabilities`, `permissions.rebac_admin_contexts`,
  `permissions.rebac_revoked_backlog` in `ravi doctor`.)

Validation: `permissions/production-readiness/CHECKS.md` and the
`permissions.rebac_*` finding ids in `doctor/check-catalog/CHECKS.md`.

## Exit Checklist

Production ready requires ALL of:

- [x] G1 model-correctness matrix test green. (`delegation.test.ts`)
- [x] G2 cross-evaluator agreement test green (`consistency.test.ts`) AND one
      shared object-id matcher (`objectIdMatches`) used by engine, snapshot,
      materializer, and explain.
- [x] G3 freshness + revoke-stops-auth tests green.
- [x] G4 `delegation.test.ts` + `capability-context.test.ts` exist and pass;
      every authority gate has allow+deny tests (tools/executables, CLI groups,
      sessions, contacts, Bash, mailbox, gateway, child-context, apps, calendar).
- [x] G5 subject-scoped restore CLI (`restore-batch --subject`) + documented
      admin-independent break-glass path, both tested.
- [~] G6 automation/role reconcile on boot (`reconcileAutomationPrincipals`) +
      `permissions.rebac_automation_uncovered` drift check. Remaining: retire
      legacy wildcard debt on issuer/bootstrap subjects (operator action).
- [x] G7 explainability/audit checks green.
- [x] G8 doctor health checks (zeroed subjects, revoked backlog, admin
      contexts, automation coverage) + `permissions prune-revoked` compaction.

## Current Status (2026-06-11, third pass)

Closed (code): G1, G2 (agreement test + unified `objectIdMatches`), G3, G4
(core `delegation.test.ts`/`capability-context.test.ts` + per-gate allow+deny
including `apps/permissions.test.ts`, `calendar/access.test.ts`, AND an
end-to-end delegated-turn gate test
`src/runtime/delegated-turn-enforcement.test.ts` that drives
buildRuntimeRequestContext → runWithContext → enforceScopeCheck/agentCan and
proves trusted-allow, untrusted-deny, no cross-actor leakage, automation-deny,
automation-covered-via-role, and surface deny-veto), G5 (`restore-batch
--subject` + operator break-glass), G7, G8 (five `permissions.rebac_*` doctor
checks + `permissions prune-revoked` + `context prune` for context compaction;
the admin-context check now filters expiry — contexts use epoch ms).

G6 substantially closed: `reconcileAutomationPrincipals` runs on boot and a
doctor check surfaces uncovered automations.

The remaining gaps are NOT code — they are operational/deployment:

1. Retire the residual full-access wildcard grants on issuer/bootstrap subjects
   (the restored `agent:dev` superadmin set, the `main` bootstrap wildcards) via
   the guarded `permissions legacy` flow once role coverage is confirmed. Left
   to a human because bulk revocation caused the 2026-06-10 incident.
2. Restart the daemon so `reconcileAutomationPrincipals` covers the ~39
   currently-uncovered live automations.
3. Run `permissions prune-revoked --apply` (~16k revoked rows) and `context
   prune --apply` (~8k inactive contexts) to compact the live store.
4. Complete the role migration so no agent depends on direct wildcards.
5. Deploy: commit, PR `dev → main`, merge; optionally wire a denial monitor on
   `ravi.audit.denied`.

The remaining optional code hardening (non-blocking): unify the role-expansion
traversal so engine and materializer share one implementation (today agreement
is test-locked); fix the test-harness global-state-lock flakiness for CI.

Superseded snapshot (first pass): G1 (model implemented), G3 (live re-materialization
of delegated contexts), G5 bulk-revocation guards + batch restore, G7
explainability/diagnosis.

Open gaps blocking production: G2 (no cross-evaluator agreement test), G4
(`delegation.ts` and `capability-context.ts` have no dedicated tests — the core
matcher is only tested indirectly), G5 (no subject-scoped restore, no
admin-independent break-glass — an incident can still lock out recovery), G6

Superseded snapshot (pre-pass): G1 (model implemented), G3 (live re-materialization
of delegated contexts), G5 bulk-revocation guards + batch restore, G7
explainability/diagnosis.

Open gaps blocking production: G2 (no cross-evaluator agreement test), G4
(`delegation.ts` and `capability-context.ts` have no dedicated tests — the core
matcher is only tested indirectly), G5 (no subject-scoped restore, no
admin-independent break-glass — an incident can still lock out recovery), G6
(automation principals fall back to a minimal base role and get denied; legacy
wildcard debt remains on issuer subjects), G8 (no archival of ~16k revoked rows,
no doctor health check).

Empirical state: role-based delegation works (agent via role role-expands to its
CLI groups) and fail-closed holds (out-of-role command denies). 6 roles, 49
memberships, 18 policies materializing — the role migration is in progress but
incomplete for automation principals.
