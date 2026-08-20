---
id: cli/crm
title: "CRM CLI interface"
kind: capability
domain: cli
capabilities:
  - crm
  - discovery
  - machine-errors
  - compact-output
tags:
  - cli
  - crm
  - agent-first
applies_to:
  - src/cli/commands/crm.ts
  - src/apps/router.ts
  - src/plugins/internal/ravi-system/skills/crm/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---

# CRM CLI interface

## Intent

`cli/crm` owns CRM operation paths, semantic arguments, compact output,
discovery, and domain-specific error identities.

## Precedence

The global `cli` spec owns the envelope, exit taxonomy, authorization,
confirmation policy, and transport behavior. `crm/facade` owns controlled
effects, and `crm/pipeline` owns pipeline metadata behavior.

## Invariants

1. Expected CRM failures MUST use the global `cli` contract with the real
   operation path and a stable CRM error code.
2. Not-found errors MUST identify the entity kind and MAY include at most three
   similar, visible identifiers in `suggestions`.
3. Invalid flags, arguments, enum values, and filters MUST be usage errors and
   expose the accepted interface fields.
4. Positional arguments MUST be semantic, such as `<pipeline>` and
   `<opportunity>`, never generated names such as `<arg1>`.
5. Migrated lists MUST accept `--fields a,b,c`; pagination MUST expose a
   literal `pagination.nextCommand` or `null`.
6. Per-operation help MUST stay compact. `ravi crm help --json` MUST provide a
   machine-readable domain overview.
7. Text-mode expected failures MUST stay concise and retain their legacy
   message, except usage errors that teach valid syntax.
8. Established immediate local mutations MUST NOT advertise an obsolete
   `--execute` flag; classification remains governed by `cli`.
9. `crm facade` operations MUST be discoverable through the same interface.
   Their state, approval, execution, verification, and recovery rules exist
   only in `crm/facade`.
10. Existing aliases and response fields used by consumers MUST NOT be removed
    or renamed without a documented consumer inventory and migration path.

## Official Error Identities

| Case | Stable code |
| --- | --- |
| Pipeline not found | `PIPELINE_NOT_FOUND` |
| Opportunity not found | `OPPORTUNITY_NOT_FOUND` |
| Contact not found | `CONTACT_NOT_FOUND` |
| CRM task not found | `CRM_TASK_NOT_FOUND` |
| Pipeline review has blocking gaps | `PIPELINE_REVIEW_FAILED` |
| Pipeline metadata is invalid | `PIPELINE_VALIDATION_FAILED` |
| Invalid command input | `USAGE_ERROR` |

The global `cli` spec determines exit codes and transport rendering.

## Delivery Scope

`pipeline` and `opportunity` expose typed errors, suggestions, semantic
arguments, compact listings, and focused help. `contact show` and `task show`
preserve entity-specific not-found identities. Other expected handler failures
use the shared compatibility boundary until assigned a specific stable code.

The shipped CRM skill MUST match live command paths, arguments, and
confirmation flags.

## Validation

- `bun test src/cli/commands/crm.test.ts src/apps/router.test.ts`
- Exercise a not-found entity, invalid flag, filtered list, and focused help
  through the real process CLI.
- Validate controlled effects against `crm/facade`, not this spec.

## Known Failure Modes

- Parser errors bypass the global usage contract and regress to plain text.
- A new option shifts positional arguments while a direct-call test remains
  aligned to an old method signature.
- Focused help mistakes a group positional argument for an operation.
- Effect rules are copied here and diverge from `crm/facade`.
