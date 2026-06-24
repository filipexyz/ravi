---
id: permissions/enterprise
title: "Enterprise Authorization (On-Prem)"
kind: capability
domain: permissions
capability: enterprise
capabilities:
  - provider-runtime
  - delegation
  - break-glass
  - audit
  - identity-federation
  - governance
tags:
  - permissions
  - enterprise
  - on-prem
  - security
  - compliance
applies_to:
  - src/permissions
  - src/runtime
  - src/cli/commands/permissions.ts
  - src/events/audit-stream.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Enterprise Authorization (On-Prem)

## Intent

Ravi targets **self-hosted, on-prem, single-tenant-per-deployment** enterprise
use: each customer runs their own Ravi, and their data never leaves their
boundary. The active turn-scoped authority model is agent identity: the agent
acts as itself under a compartment-scoped identity, host-enforced before every
tool call. Enterprise work wraps that core with audit, governance,
administration, and optional user-level overlays required for regulated
deployments.

This spec is the umbrella. It defines the direction and the phase order; each
phase has its own normative feature spec.

## Why It Matters

A powerful AI agent is a blast-radius machine: the more tools it can reach, the
more dangerous a compromised or confused turn is, and the model cannot be
trusted to self-enforce (prompt injection is a certainty, not a risk). The
authorization layer is the only real control between "useful agent" and
"catastrophic blast radius" — it is not a feature of the product, it is the
condition that makes deploying the product survivable.

Commercially, every gap below maps to a procurement gate (security review,
identity/IT, compliance). You do not reach the contract without passing them.
Strategically, a rigorous, provable, on-prem authorization layer is the answer
to the only enterprise buying question in the agent era: "can I trust this
autonomous thing inside my organization?"

See `permissions/enterprise/WHY.md` for the full rationale.

## Deployment Model

- Each deployment is a single tenant. Cross-tenant isolation is NOT required
  inside one deployment; it is provided by deployment separation.
- Authorization stays local and provider-owned. Enterprise work MUST NOT
  introduce a mandatory external authorization service that breaks the
  local-first, data-never-leaves guarantee.
- Multi-tenant SaaS is explicitly out of scope for this spec.

## Invariants

- The turn-scoped agent identity model MUST remain the enforcement core.
  Enterprise features wrap it; they MUST NOT silently revert to per-user
  capability intersection or ambient agent authority.
- No authority-bearing action may be authorized by the mere ABSENCE of a
  principal. Every allow MUST trace to an explicit, authenticated principal —
  agent, actor, automation, or operator. (See `enterprise/break-glass`.)
- Every authority decision affecting state, disclosure, or external effect MUST
  be auditable, including allows. The audit record MUST be tamper-evident and
  exportable off-box. (See `enterprise/audit`.)
- Actors MUST be mappable to a federated enterprise identity, and any
  user-level overlay on top of agent identity MUST be representable in a
  standard, auditable form. (Later phase.)
- Governance reads ("who can do X?", access reviews) MUST be answerable from
  persisted state. (Later phase.)

## Phase Order

Ordered by "what lands and keeps the first enterprise customer":

1. **Phase 0 — Close the holes a security review fails on (this spec set):**
   - `permissions/enterprise/break-glass` — replace the implicit
     "no agent principal ⇒ full authority" bypass with an authenticated,
     audited, optionally approval-gated operator break-glass.
   - `permissions/enterprise/audit` — complete (allows + denies),
     tamper-evident, exportable audit.
   - (Also: encryption at rest — tracked separately.)
2. **Phase 1 — Identity:** OIDC/SAML SSO, SCIM provisioning, on-behalf-of
   delegation tokens (`sub` human + `act.sub` agent), IdP-group → role mapping.
3. **Phase 2 — Governance:** reverse query ("who can do X?"), access
   reviews/recertification, SIEM audit export, least-privilege reporting.
4. **Phase 3 — Admin plane:** customer admin console, admin RBAC, approval and
   JIT/time-bound workflows.
5. **Phase 4 — Assurance:** analyzable policy (Cedar or equivalent) for formal
   invariants over the decision layer, kept local and embedded.

## Acceptance Criteria (Phase 0)

- A pentest of a deployment finds NO path to authority via the absence of an
  agent principal. Operator/break-glass requires an authenticated operator and
  is recorded.
- Every sensitive allow and every deny is present in the tamper-evident audit
  log and exportable.
- The local single-operator developer workflow still works, but only under an
  explicit operator identity, not silent bypass.
