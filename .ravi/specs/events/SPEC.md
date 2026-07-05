---
id: events
title: "Events"
kind: domain
domain: events
capabilities:
  - audit-stream
  - topic-registry
  - gap-analysis
tags:
  - events
  - nats
  - audit
  - replay
  - triggers
applies_to:
  - src/events
  - src/triggers/topic-catalog.ts
  - src/nats.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Events

## Intent

The events domain owns the canonical set of NATS subjects that Ravi publishes, the audit/replay stream that captures them, and the trigger topic catalog that exposes them to routines.

Events are the primary observability and integration surface for Ravi. Every lifecycle mutation, policy decision, and runtime state change that matters for debugging, automation, or operational awareness SHOULD be represented as a published NATS event with a safe, documented payload.

## Boundary

Events own:

- the `RAVI_EVENTS` JetStream stream definition and subject list (`src/events/audit-stream.ts`);
- the trigger topic catalog (`src/triggers/topic-catalog.ts`);
- the `ravi events stream` CLI surface for live event tailing;
- event subject naming conventions and payload safety rules;
- gap analysis and coverage tracking for canonical event subjects.

Events do NOT own:

- transport-level NATS configuration (owned by daemon);
- trigger runtime execution (owned by `routines/triggers`);
- provider-specific raw events (owned by `runtime/providers`);
- session prompt workqueue subjects (`ravi.session.*.prompt`).

## Invariants

- Every `ravi.*` subject that carries operational meaning MUST be documented in either the audit stream subject list or the trigger topic catalog.
- Event payloads MUST NOT contain secrets, credentials, raw prompts, raw context blobs, context keys, private local paths, or unredacted user/customer data.
- Events classified as `public-trigger` MUST have a safe schema in the trigger topic catalog.
- Events classified as `replay-only` or `internal-control` MUST be captured by the `RAVI_EVENTS` stream but MUST NOT appear in the trigger topic catalog until reviewed for safety.
- New event subjects MUST follow the naming convention: `ravi.<domain>.<entity-or-action>[.<phase>]`.
- The audit stream subject list and trigger topic catalog MUST NOT overlap with the session prompt workqueue (`ravi.session.*.prompt`).

## Validation

- `bun test src/events/audit-stream.test.ts`
- `ravi specs sync --json`
