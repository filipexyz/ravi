---
id: permissions/explain
title: "Permission Explainability"
kind: capability
domain: permissions
capability: explain
capabilities:
  - rebac
  - delegation
  - audit
  - denials
  - provenance
tags:
  - permissions
  - explainability
  - audit
  - operations
applies_to:
  - src/permissions/scope.ts
  - src/permissions/denials.ts
  - src/permissions/audit-provenance.ts
  - src/permissions/relations.ts
  - src/permissions/delegation.ts
  - src/cli/commands/permissions.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Permission Explainability

## Intent

Every authority decision Ravi makes MUST be explainable from persisted state
with one command, without raw SQL and without re-deriving the engine by hand.

Opacity is a failure mode of the permission system, not a cosmetic issue. A
denial that can only say "capability count is 0" hides the difference between
"this surface was never trusted" and "this surface lost 103 grants in a bulk
revocation last night", and it pushes operators toward the wrong fix
(re-granting wildcards) instead of the right one (restoring or replacing the
revoked authority).

## Invariants

- Explain output MUST be produced by the same evaluator used for enforcement.
  A parallel re-implementation that can disagree with the engine is forbidden.
- Explain MUST cover both authorization paths: direct agent checks
  (`agentCan`) and delegated turn-scoped contexts (agent, actor, surface, turn
  branches, delegation overrides, role expansion).
- Every branch decision MUST cite the concrete relations that produced it,
  with provenance: `source`, `issued_by`, `grant_mode`, `created_at`,
  `expires_at`, `revoked_at`, and role/policy expansion path when applicable.
- Explain MUST distinguish these grant states for the requested capability:
  - `never_granted`: no tuple, active or inactive, ever matched.
  - `revoked`: a matching tuple exists with `revoked_at` set.
  - `expired`: a matching tuple exists with `expires_at` in the past.
  - `constrained`: actor/agent allow, but a surface constraint or
    `deny_<relation>` veto blocks it.
  - `ceiling`: actor/surface allow, but the executor agent lacks the
    capability.
- Near-miss disclosure: when the decision is deny and inactive tuples would
  have authorized the capability, explain MUST list them with their
  deactivation reason and timestamp. "It would have been allowed before
  <event>" is required output, not optional color.
- Revocation event awareness: revocations that share the same revocation
  batch or timestamp above a small threshold MUST be reported as one named
  event ("N relations revoked at <time> by <issuer>"), not as N independent
  missing grants.
- Capability counts embedded in runtime context metadata and audit events
  (`actorCapabilityCount`, `surfaceCapabilityCount`, ...) are point-in-time
  snapshots. Explain and denial tooling MUST re-resolve current graph state
  and MUST label snapshot values with the moment they were taken.
- Turn-scoped approval caps are decision inputs, not just metadata. When a
  denial was recorded with `turnCapabilities`, explain MUST apply them as the
  same upper-bound used by enforcement and MUST expose a turn branch when that
  upper-bound allows or blocks the request.
- Recommended fixes MUST be ranked: role membership first, narrow scoped
  direct grant second, delegation override third. Explain MUST NOT recommend
  wildcard or full-access template grants unless the caller explicitly asks
  for broad options.
- Explain is a disclosure surface. It MUST apply the same resource-visibility
  rules as other discovery commands when invoked from an agent/runtime
  context.

## CLI Contract

```bash
# Explain a hypothetical or reproduced decision
ravi permissions explain <relation> <object-type>:<object-id> \
  --agent <agent-id> \
  [--actor contact:<contact-id>] \
  [--chat <chat-id>] \
  [--session <session-key>] \
  --json

# Explain a persisted denial by id
ravi permissions explain --denial <denial-id> --json
```

Rules:

- With `--denial`, the command MUST reconstruct the decision from the denial
  row and its recorded context, then ALSO evaluate current state and report
  whether the same request would deny today.
- Without `--actor`/`--chat`, the command explains the direct agent path and
  MUST say explicitly that delegated branches were not evaluated.
- `--json` output MUST include: per-branch verdicts, matched tuples with
  provenance, near-miss tuples with deactivation info, detected revocation
  events, the final decision, and ranked recommendations.

## Denial Diagnosis Requirements

The denial diagnosis attached to `permission_denials.detail_json` and
`ravi.audit.denied` events MUST:

- include the grant state (`never_granted`, `revoked`, `expired`,
  `constrained`, `ceiling`) per zero or blocking branch;
- reference detected revocation events with timestamp and issuer when the
  blocking branch lost authority to one;
- keep the existing recommended-grant output, but rank it per the
  recommendation rules above;
- never present point-in-time capability counts as live state.

## Acceptance Criteria

- After a bulk revocation, a denial on an affected surface explains "surface
  had N matching grants revoked at <time> (revocation event <id>)" instead of
  only "surfaceCapabilityCount=0".
- `ravi permissions explain --denial <id>` reproduces the recorded decision
  and reports whether current state still denies.
- For an allow, explain can attribute every effective capability to a direct
  grant, role expansion, delegation override, or turn approval.
- Explain output and a real enforcement check never disagree for the same
  inputs at the same graph state.
- A `never_granted` surface and a `revoked` surface produce visibly different
  diagnoses in both CLI output and audit events.
