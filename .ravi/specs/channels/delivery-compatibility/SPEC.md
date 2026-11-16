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
  to a live OS process start token, executable, exact kernel arguments and bundle digest.
  The controller supplies independently observed launch expectations. File
  discovery alone MUST NOT define the expected consumer inventory.
- Kernel process observation MUST distinguish boot identity from PID existence.
  Missing, dead, reused or inaccessible process identity and unsupported OS
  layouts MUST produce unknown. An orphan file MUST NOT authorize anything.
- The publisher inside the consumer MUST capture `argv1Raw` exactly as observed
  from the kernel and bind it to an absolute canonical `bundlePath`. Only that
  publisher resolves the raw entrypoint in its own cwd. The controller MUST NOT
  resolve raw argv or depend on observing the consumer's cwd.
- Verification MUST compare `observed.argv[1] === expected.argv1Raw`, exact full
  argv equality, process start token and executable. The declaration MUST agree
  with the launch expectation on raw argv and absolute bundle. The absolute
  expected bundle MUST remain canonical and match its expected digest.
- A positively observed different entrypoint/bundle or bundle digest MUST be
  unsupported. Missing/unreadable bundle or failed realpath MUST return unknown
  with a serializable diagnostic code, message and underlying cause; verification
  and gate inspect/acquire MUST NOT throw a raw filesystem exception. Diagnostics
  MUST survive in the aggregate snapshot. Unknown never permits a callback and
  revokes an existing permit on revalidation. Absent process/boot evidence
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
