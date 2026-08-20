---
id: crm/facade
title: "CRM Agent-First Facade"
kind: capability
domain: crm
capability: facade
capabilities:
  - planning
  - approval
  - controlled-effects
  - reconciliation
tags:
  - crm
  - agent-first
  - approval
  - effects
  - recovery
applies_to:
  - src/crm/facade.ts
  - src/crm/facade.test.ts
  - src/contacts.ts
  - src/approval/service.ts
  - src/approval/service.test.ts
  - src/cli/commands/crm.ts
  - src/cli/commands/crm.test.ts
  - src/cli/commands/operational-return-schemas.ts
  - src/sdk/client-codegen/crm-contract.test.ts
owners:
  - ravi-dev
status: active
normative: true
---

# CRM Agent-First Facade

## Intent

The CRM facade gives agents a controlled path from an exact CRM intent to one
observable effect. It persists an immutable short-lived plan, binds approval to
a runtime-derived destination snapshot plus an exact external message and
sender, claims the effect once, journals before dispatch, and evaluates an
operation-specific success predicate against an independent readback.

## Supported Operations

The facade MUST support exactly these operations in version
`crm.agent-first/v1`:

- `task.done`
- `task.cancel`
- `task.snooze`
- `opportunity.move`
- `fact.confirm`
- `fact.reject`
- `contact.set`
- `account.link-contact`
- `opportunity.link-contact`

Adding another operation requires its own target resolution, input validation,
precondition check, effect implementation, readback comparison, and tests.

## State Model

```text
planned --matching approval--> approved --atomic claim--> applying
applying --satisfying readback--> applied
applying --divergent readback--> partial
applying --ambiguous execution or unreadable result--> unknown
```

An approval request is stored on a `planned` plan before the matching response
moves it to `approved`. Expiry is a blocking condition, not a persisted state.
`applied`, `partial`, and `unknown` are terminal for application.

After the atomic claim, a process exit can leave the durable state at
`applying`. That state is also non-replayable: it requires read-only inspection
and manual reconciliation rather than another application attempt.

## Observation Model

`verify` and `recover` report an observed outcome without changing the
persisted plan state:

- `applied` means the independent readback satisfies the operation-specific
  success predicate;
- `not_applied` means it does not match while the plan is still `planned` or
  `approved`;
- `partial` means it does not match after the plan persisted `applied` or
  `partial`;
- `not_determined` means it does not match while the plan is `applying` or
  `unknown`.

These outcomes MUST NOT be treated as additional plan states. If no readback
can be obtained, observation cannot classify the effect and MUST NOT authorize
a replay. An `applied` outcome proves only that the expected condition is
currently visible; it does not prove that this plan caused it.

## Invariants

- Planning MUST resolve the exact primary target and every supplied CRM
  reference before persistence. Planning MUST NOT change CRM business data.
- A plan MUST contain one primary effect, `retry: never`, a canonical SHA-256
  hash, creation time, and an expiry exactly 15 minutes after creation.
- The persisted plan payload MUST be checked against its stored hash whenever it
  is loaded. An integrity mismatch MUST block approval, application, and
  verification.
- Plans, approval receipts, and effect journals MUST persist in the existing CRM
  state database so separate CLI invocations share the same state.
- `crm facade approve` MUST derive channel, account, chat, optional thread
  metadata, and authorized sender identity from the current Ravi runtime
  context. The caller MUST NOT supply approval source or agent identity flags.
- Missing runtime channel, account, chat, or sender identity MUST fail closed
  before an approval request is accepted.
- The external approval message MUST show the plan id, plan hash, operation,
  resolved target, complete canonical arguments, and expiry. Approval MUST NOT
  be requested from a summary that omits any effect argument.
- The durable approval receipt MUST bind the plan hash, external message id,
  configured destination snapshot, authorized sender, actual sender, and
  timestamps. Authorization MUST require the matching external message id and
  sender id. Stored thread metadata is audit context; the current transport does
  not deliver or independently verify it.
- Apply MUST require an integral, unexpired `approved` plan and a matching
  approved receipt.
- Apply MUST re-read the target, transition, stage, contact, account, and
  contact-field references used by the plan before claiming the effect.
- The transition from `approved` to `applying` MUST be an atomic compare-and-set
  claim. A plan MUST be consumed at most once.
- The effect journal MUST be durably written after the claim and before effect
  dispatch. Failure to establish that journal MUST produce `unknown` without
  dispatching the CRM effect.
- The facade MUST propagate the effect id as the mutation idempotency key, but
  replay prevention MUST rely on the atomic plan claim. The facade MUST NOT
  automatically retry or replay a claimed effect.
- An independent readback that satisfies the operation-specific success
  predicate MUST persist `applied`. A readable but divergent result without an
  execution error MUST persist `partial`.
- An unreadable result or an execution error whose readback does not prove the
  effect MUST persist `unknown`. `unknown` MUST NOT authorize a replay.
- `verify` and `recover` MUST be read-only. Recovery MUST return
  `replay: false` and require manual review; it MUST NOT reopen or mutate the
  plan.

## Authority and Timing

- `plan`, `verify`, and `recover` are read operations.
- `approve` and `apply` require the `writeContacts` scope.
- A plan expires after 15 minutes. The approval service waits up to five minutes
  for a matching response unless its internal caller supplies another timeout;
  the public CRM command exposes no timeout option.

## Scope Boundary

This contract governs only `crm facade` and its nine operations. Existing CRM
commands and direct write APIs remain available during migration and do not
automatically inherit these guarantees. The lifecycle description is therefore
facade-only, not global enforcement for legacy mutations.

The known legacy differences are intentional migration boundaries:

- contact profile updates validate values but do not enforce a transition
  matrix;
- opportunity moves derive status from the destination stage;
- task completion and cancellation can overwrite the opposite terminal state,
  while snooze rejects both terminal states;
- legacy fact status updates accept transitions broader than the facade's
  `proposed -> confirmed|rejected` rule.

## Validation

- Resolve `crm/facade` in both `full` and `checks` modes.
- Run the focused facade, CRM CLI, and approval-service tests listed in
  `CHECKS.md`.
- Run the generated-contract and repository gates in `CHECKS.md` before merge.

## Known Failure Modes

- The process can stop after the claim and leave the durable plan `applying`.
  The journal state `dispatched` records the pre-dispatch fence; it does not
  prove the mutation call ran. Neither state authorizes replay.
- Current CRM state can change between planning and application. Revalidation
  blocks known stale state, but it is not one transaction spanning every CRM
  record.
- Approval identity relies on the configured channel transport. The facade
  checks message and sender ids, but it does not verify the stored thread end to
  end or add an independent cryptographic signature.
- Approval denial or timeout leaves the plan `planned` with its first request
  receipt. The same plan cannot request a second approval, and retrying the
  command can emit an unusable message before receipt binding fails.
- An expired, already requested, or non-planned plan can emit an approval
  message before the durable state check rejects its receipt.
- A success predicate confirms only the primary observable postcondition. For
  example, task cancellation does not read back its reason, and link operations
  do not prove every secondary primary-link update.
- A legacy consumer can bypass the facade by calling a direct CRM write path.
  Removing that bypass requires a separate consumer migration.
