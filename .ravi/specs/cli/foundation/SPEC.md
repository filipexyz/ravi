---
id: cli/foundation
title: Agent-first CLI foundation
kind: capability
domain: cli
capabilities:
  - output-integrity
  - public-errors
  - field-selection
  - pagination
  - effect-metadata
tags:
  - cli
  - agent-first
  - safety
applies_to:
  - src/cli
  - src/permissions/scope.ts
  - src/runtime/host-services.ts
  - src/runtime/types.ts
  - src/sdk/client-codegen
owners:
  - ravi-dev
status: draft
normative: true
---

<!-- markdownlint-disable MD025 -->

# Agent-first CLI foundation

## Intent

Agent consumers must be able to trust that a completed CLI process delivered a
complete response with a stable meaning. Shared transport and contract behavior
belongs to this capability; business rules remain in domain specs.

## Invariants

- A registered one-shot CLI command MUST NOT terminate at its top-level command
  boundary before pending stdout, stderr, audit, and required transport work has
  completed or failed explicitly. Interactive loops and child-process lifecycle
  callbacks remain explicit migration exceptions listed in `RUNBOOK.md`.
- Output flushing MUST be bounded. A stream that never reports progress MUST
  time out without busy-spinning, and the requested process termination MUST
  still occur so a broken pipe cannot hold the CLI indefinitely.
- Large JSON responses MUST be emitted as one complete document when stdout is
  a pipe.
- Expected failures MUST carry a public, typed, non-secret message. Unexpected
  failures MUST retain a generic public message and keep internal details out of
  the response.
- Caller mistakes MUST use `USAGE_ERROR` and exit code `2`. Operational or
  domain failures, including unavailable retryable dependencies, MUST use exit
  code `1`; retryability is carried separately in the envelope. Exit code `3`
  is reserved for policy or confirmation blocks that prevent an effect safely.
- A domain command migrated to strict field selection MUST validate against a
  stable public field set before projecting records. For those migrated
  commands, any unknown field MUST fail with `USAGE_ERROR`, exit code `2`, and
  `acceptedFields`, including when the result set is empty. Legacy callers of
  `pickFields` remain permissive until their domain pull request supplies the
  accepted field set.
- Pagination inputs MUST be validated before querying. Invalid limits, offsets,
  or cursors MUST fail as usage errors rather than operational failures.
- SDK drift checks MUST ignore checkout-only CRLF/LF conversion while still
  rejecting any source-content difference.
- Existing offset pagination responses MUST remain backward compatible while a
  domain is migrated. Mutable operational datasets SHOULD adopt cursor-based
  continuation in their domain pull request.
- Every public command MUST expose its operation kind, effect class, risk, and
  confirmation requirement through agent-discoverable command manifests and
  the host runtime's dynamic-tool catalog. Unreviewed mutations MUST remain
  visibly `unclassified`.
- A command that declares confirmation MUST be proven to stop before its first
  effect when confirmation is absent. Metadata alone MUST NOT count as a brake.

## Ownership boundary

The foundation owns one-shot command writers and termination, public error
types, shared validators, manifest fields, runtime catalog propagation, and
structural checks. A domain owns resource-specific error codes, accepted fields,
query ordering, cursor construction, effect classification, read-back, and
recovery. Interactive loops and child-process lifecycle callbacks remain owned
by their commands until their domain migration.

## Safety metadata

The public `effectClass` vocabulary is:

- `none` for reads;
- `local-reversible` for immediate local writes with a defined inverse;
- `external` for communication, publication, sharing, or provider state;
- `destructive` for irreversible removal or secret rotation;
- `authority-expansion` for added permission or exposure;
- `triggered-work` for work that continues independently;
- `containment` for immediate authority reduction or emergency stop;
- `cost-threshold` when a trustworthy estimate reaches a configured limit;
- `conditional` when the invocation determines whether an effect is material;
- `unclassified` for legacy mutations awaiting domain review.

`unclassified` MUST remain visible and MUST NOT be interpreted as safe. At this
draft stage, real legacy mutations are expected to remain unclassified; domain
pull requests replace that value with a declared class and prove their actual
brake. `classificationSource` reports whether the value was declared, inferred
for a read, or retained as a legacy unknown.

## Acceptance criteria

- A native process test receives a valid JSON payload larger than 64 KiB through
  a pipe with no truncation and exit code `0`.
- A synthetic stuck stream reaches its bounded timeout without holding the
  process, and a native timed-out child is killed and observed before the test
  returns.
- Expected safe messages remain visible; unexpected internal messages do not
  leak.
- Unknown `--fields` values fail before projection with `acceptedFields` and
  exit code `2` for the migrated `agents list` surface; each domain adds the
  same proof when it migrates its own field sets.
- Invalid shared pagination inputs use `USAGE_ERROR` and exit code `2`.
- Exported command definitions contain effect, risk, and confirmation metadata.
- A synthetic structural confirmation test proves the shared brake mechanism
  stops before its first effect. Every real mutation remains subject to a
  domain-owned no-effect proof before its classification can leave
  `unclassified`.
