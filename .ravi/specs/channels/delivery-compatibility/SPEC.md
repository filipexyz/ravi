---
id: channels/delivery-compatibility
title: Delivery Compatibility Oracle
kind: capability
domain: channels
capability: delivery-compatibility
status: active
normative: true
applies_to:
  - src/channels/delivery-protocol.ts
  - src/channels/delivery-contract.ts
  - src/channels/delivery-process.ts
  - src/channels/delivery-boot.ts
  - src/channels/delivery-activation.ts
owners:
  - main
---

# Delivery compatibility

## Scope

This PR supplies inactive infrastructure only. No production bootstrap imports
the oracle, no schema is installed, and no recovery, consumer, provider, pruning
or envelope behavior is activated. The future offline migration owns creation of
`channel_delivery_contract`; a missing floor is unknown, never permission to
initialize it. Compatibility is necessary but is not a cutover or send permit.

## Invariants

- Each participating boot MUST publish its delivery protocols, receipt read and
  write schema versions, and `part_receipts`/`uncertain` features. Compiled
  capabilities MUST NOT be overridden by environment or health data.
- A private immutable file under
  `runtime-processes/delivery/<name>-<pid>-<bootId>.json` MUST bind that declaration
  to a live OS process start token, executable, working directory, arguments and bundle digest.
  The controller supplies independently observed launch expectations. File
  discovery alone MUST NOT define the expected consumer inventory.
- Kernel process observation MUST distinguish boot identity from PID existence.
  Missing, dead, reused or inaccessible process identity and unsupported OS
  layouts MUST produce unknown. An orphan file MUST NOT authorize anything.
- A direct entrypoint MUST be resolved against the consumer's kernel-observed
  working directory and canonicalized before comparison. The controller's cwd
  MUST NOT affect the result. Relative, absolute and symlink spellings of the
  same entrypoint MUST compare equally; other arguments remain exact.
- A positively observed different entrypoint or bundle digest MUST be
  unsupported. An observer unable to resolve the consumer cwd or entrypoint
  MUST throw `DeliveryProcessObservationError` with a diagnostic code and cause,
  rather than silently reducing that defect to unknown. Both errors and rejected
  relations MUST prevent callbacks; an observation error during revalidation
  permanently revokes the existing permit. Absent process or boot evidence
  remains unknown. Ambiguous wrapper/flag launch layouts are not supported.
- `channel_delivery_contract` MUST be read with a readonly/create:false SQLite
  handle and no store initializer. The singleton defines migration id/digest,
  epoch, minimum and active delivery protocol, receipt schema, required features.
  Missing/malformed metadata MUST NOT trigger migration or fallback.
- Supports requires the exact active protocol, read AND write support for the
  installed schema, and every required feature. Numerically newer protocols do
  not imply support for an older active version. Valid incompatible declarations
  are unsupported; unverified evidence is unknown.
- Every expected consumer MUST support the same installed contract. An empty,
  duplicated, unstable or wrong-scope inventory is unknown. Any unsupported or
  unknown member blocks the entire cohort, including otherwise supported boots.
- The aggregate gate MUST revalidate its floor and live boot inventory before
  invoking recovery, pull, claim, send or prune. Opaque permits are local to the
  issuing gate and MUST bind the contract, inventory epoch and exact boot cohort.
  Replacement boots or changed floors invalidate old permits, even if the new
  cohort supports the contract. A rejected permit cannot become valid again.
- Gate validation invokes no effect callback on rejection. Compatibility checks
  do not prove delivery, turn unknown into confirmed, or clean up uncertain rows.
- Runtime readiness, state-schema readiness and the Threads protocol/fence are
  separate oracles. A process can be ready and incompatible with delivery.

## Activation boundary

The launch registry and offline process interlock belong to the controller.
This library does not discover unregistered writers, stop services, prove drain,
or perform migration. A future integration MUST first satisfy the approved
offline cutover, then call these guarded entry points. A compatibility permit
alone MUST NOT be used to authorize a migration or bypass the transactional
pre-send/receipt guard. Revalidation is synchronous at callback entry; this is
not an atomic transaction with the OS or an external provider.

## Validation

See CHECKS.md for focused tests using real child processes and isolated state.
