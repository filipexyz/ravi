# Credential Controls Why

## Why Controls Now

The credentials broker is security-critical. It should be built with controls
from the beginning, even though Ravi does not need a formal compliance program
for this workstream right now.

Controls now means:

- define what must be true;
- make it testable;
- emit useful audit/evidence as a side effect;
- avoid future rewrites.

It does not mean:

- start SOC 2 certification;
- collect auditor-ready evidence manually;
- block the MVP on policy paperwork.

## Why Not Formal Compliance Yet

Formal compliance is premature until the broker has:

- production storage shape;
- first provider integration;
- real authorization/approval flow;
- audit events;
- lifecycle operations such as rotation and disablement.

Before those exist, a compliance program would mostly document intentions. The
more useful work is implementing controls directly in the broker.

## Why SOC 2 Vocabulary Is Still Useful

SOC 2-style control thinking is useful as a vocabulary for:

- access control;
- change management;
- incident response;
- confidentiality;
- availability and failure modes;
- auditability.

The credentials domain should use those ideas as engineering constraints, not
as an audit target.

## Decision

Use `credentials/controls` as a lightweight control map. Do not create a formal
`credentials/compliance/soc2` spec until there is a real external need or an
enterprise/customer requirement.
