---
id: crm
title: "CRM domain (contacts, accounts, opportunities, pipelines)"
kind: domain
domain: crm
capabilities:
tags:
applies_to:
owners:
status: active
normative: true
---

# CRM domain (contacts, accounts, opportunities, pipelines)

## Intent

Make CRM changes safe for agents without removing the established CRM commands.
The `crm facade` path resolves an exact target, produces an immutable short-lived
plan, obtains external approval, applies a single effect, and reads the result
back. Existing CRM commands remain compatible during migration.

## Invariants

1. A facade plan MUST contain an exact resolved target, immutable hash, expiry,
   one primary effect, and `retry: never`.
2. Planning and verification MUST NOT change CRM data.
3. Applying a plan MUST require one external approval bound to its plan hash;
   absence, mismatch, expiry, or prior consumption MUST block the effect.
4. The effect journal MUST be written before dispatch. A dispatch error or an
   uncertain result MUST become `unknown` and MUST NOT be replayed automatically.
5. A successful effect MUST be read back independently before the plan becomes
   `applied`.
6. Facade plans and journals MUST use the CRM state database so separate CLI
   invocations retain their state.

## Validation

- Unit-test planning, expired plans, approval binding, single-use apply, and
  `unknown` recovery behavior.
- Run the CRM command, type, build, and SDK contract suites before merge.

## Known Failure Modes

- A process may fail after dispatch and before readback. This is `unknown`, not
  permission to repeat the action.
- Approval transport can be unavailable or denied. The plan remains unapplied.
- Legacy CRM writes intentionally remain available during migration; therefore
  this contract protects the facade path rather than claiming to eliminate every
  legacy write path.
