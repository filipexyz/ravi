---
id: permissions/explain/why
title: "Why Permission Explainability"
kind: why
domain: permissions
capability: explain
---

# Why Permission Explainability

## Decision

Explainability is a first-class permission capability with its own evaluator
contract, CLI surface, and denial-diagnosis requirements — not a formatting
concern of audit events.

## The Incident That Forced This

On 2026-06-10 ~23:17, a legacy cleanup
(`ravi permissions legacy --apply --confirm legacy-cleanup`, two waves)
revoked ~16,000 manual relations. The issuing session granted full access to
itself, its operator contact, and its own chat surface minutes before
applying, so its own turns kept working while every other chat surface
dropped to zero capabilities.

The next morning, denials reported `surfaceCapabilityCount=0` with a
minimal-grant recommendation per surface. That diagnosis was technically
accurate and operationally useless:

- it could not distinguish "this surface was never granted anything" from
  "this surface had 103 grants revoked last night in one batch";
- it recommended per-tuple re-grants, which would have rebuilt the wildcard
  debt the cleanup was trying to retire, one denial at a time;
- the agent asked to fix it could not, because its own admin grant had been
  revoked in the same sweep — and the diagnosis did not say that either;
- root-causing required raw SQL against `relations.revoked_at`.

Every fact needed for the correct diagnosis was already persisted. The system
chose not to look at inactive tuples when explaining a zero branch.

## Why Same-Evaluator

A hand-written explainer drifts from the engine the first time intersection,
role expansion, override, or veto semantics change. The only explanation that
can be trusted is the one computed by the code that enforced the decision.

## Why Revocation Events Are First-Class

Mass operations are part of the system's lifecycle (legacy retirement, policy
reconciliation, role closure revalidation). When thousands of tuples change in
one batch, the unit of explanation is the batch, not the tuple. Diagnoses that
ignore batch structure turn one operational event into thousands of apparently
unrelated denials.

## Why Ranked Recommendations

The denial surface is where operators decide what to grant. If the easiest
path offered is a direct wildcard tuple, the graph degrades back into
thousands of unmanageable rows. Recommending role membership first makes the
healthy structure the path of least resistance.

## Tradeoffs

- Looking at inactive tuples on every denial adds query cost. Acceptable:
  denials are rare relative to allows, and the inactive scan is indexed by
  subject.
- Reporting revocation events in denials discloses operational history to the
  denied session. Acceptable within resource-visibility rules; the issuer and
  batch size are not secrets from the operator fixing the denial.
