---
id: tasks/reporting/delivery
title: "Task Reporting Delivery"
kind: feature
domain: tasks
capability: reporting
feature: delivery
capabilities:
  - task-reporting
  - task-events
  - report-delivery
  - observer-status
tags:
  - tasks
  - reporting
  - delivery
  - observers
  - sessions
applies_to:
  - src/tasks/service.ts
  - src/tasks/session-publisher.ts
  - src/tasks/checkpoint-runner.ts
  - src/tasks/types.ts
  - src/cli/commands/tasks.ts
  - src/runtime/observation-plane.ts
  - src/runtime/observation-profiles.ts
  - src/plugins/internal/ravi-system/observers/profiles/tasks
owners:
  - ravi-dev
status: active
normative: true
---

# Task Reporting Delivery

## Intent

Task Reporting Delivery defines how task progress and terminal state move from worker sessions, observer sessions, or CLI callers into durable task state and, when configured, into a report target session.

The feature exists so task status is not left as chat-only prose. Durable state belongs to the task runtime; delivery to humans or coordinating sessions is a secondary, explicit report path.

## Event Model

Task report delivery recognizes terminal report events:

- `blocked`;
- `done`;
- `failed`.

These map to task event types:

- `task.blocked` -> `blocked`;
- `task.done` -> `done`;
- `task.failed` -> `failed`.

Progress reports created with `ravi tasks report` update durable task progress and emit task events, but they are not part of the terminal report-event filter unless a future spec explicitly extends the filter model.

## Report Targets

A task or assignment MAY define:

- `reportToSessionName`;
- `reportEvents`;
- `checkpointIntervalMs`.

Assignment-level report target and report events MUST override task-level values for that assignment. If no explicit report target is configured, task event reporting MUST NOT publish a report prompt to another session.

When `reportEvents` is empty or invalid, the effective event set MUST fall back to the canonical task report event set: `blocked`, `done`, and `failed`.

The report target name MUST be resolved relative to the source task session when the configured value is contextual.

## Durable State Sync

The task CLI commands are the canonical mutation surface:

```bash
ravi tasks report <task-id> --message "..." [--progress <0-100>]
ravi tasks done <task-id> --summary "..."
ravi tasks block <task-id> --reason "..."
ravi tasks fail <task-id> --reason "..."
```

`report` MUST require a descriptive message. For profiles that use `TASK.md`, that message MAY come from `frontmatter.progress_note`; otherwise callers MUST pass `--message`.

`done` MUST require a completion summary. For profiles that use `TASK.md`, that summary MAY come from `frontmatter.summary`; otherwise callers MUST pass `--summary`.

`block` MUST require a concrete blocker reason. For profiles that use `TASK.md`, that reason MAY come from `frontmatter.blocker_reason`; otherwise callers MUST pass `--reason`.

`fail` MUST require a terminal failure reason. For profiles that use `TASK.md`, that reason MAY come from `frontmatter.summary` or `frontmatter.blocker_reason`; otherwise callers MUST pass `--reason`.

Every successful mutation MUST emit task events through the task runtime.

## Delivery Prompt

When a configured task event matches the effective report event filter, Ravi MUST publish a prompt to the resolved report target session.

The delivery prompt MUST:

- identify the source task session;
- include the task id and task state;
- include the profile-aware primary artifact when available;
- include the effective cwd and worktree context when available;
- include the summary, blocker, or event message that explains the report;
- use a delivery barrier that avoids interrupting the source response.

The source task session MUST NOT wait for the report target session to finish processing the report.

## Observer Integration

The `observed-task` profile delegates durable status synchronization to a sidecar observer.

For observed tasks:

- the worker prompt SHOULD ask the worker to state progress, blockers, done, and failure clearly in ordinary responses;
- the worker prompt MUST NOT require normal `ravi tasks report|block|done|fail` calls by default;
- an observer rule MAY attach a task-status observer for `sourceProfileId=observed-task`;
- the observer profile `tasks` MAY inspect worker events and call task mutation commands when its own runtime context grants those tools;
- observer status updates MUST be idempotent enough to tolerate duplicate event delivery.

Task reporting observers MUST remain isolated observer sessions with their own permissions. They MUST NOT inherit worker tool authority by default.

## Cross-Store Delivery Protocol

Report delivery crosses from work-owned task state to a core-owned target
session. Once storage is split by workload this is a cross-store effect and MUST
follow the same intent/receipt discipline as `tasks/dispatch`.

- The report delivery idempotency key MUST derive from the durable task event
  (its stable id), the resolved target session, and the renderer/protocol
  version. It MUST be stable across retries.
- A `payloadHash` MUST cover the rendered report prompt plus renderer/protocol
  version. Same key + same hash is a safe replay; same key + different hash MUST
  fail closed as a payload-hash conflict and surface repair evidence.
- Replay MUST NOT deliver a duplicate report prompt to the target session.
- The work-side source intent (the task event and its delivery intent) MUST
  remain distinguishable from the core-side enqueue receipt/acknowledgement. A
  report MUST be marked delivered only after a durable core enqueue receipt for
  the same key and payload hash; enqueue attempt alone is not delivery.
- Transient delivery failure MUST remain retryable with the same key. Terminal
  failure MUST move to an explicit dead-letter state that is repairable.
- Work modules MUST publish report prompts through the typed core session port,
  not through untyped infrastructure. Runtime/report readers of work state MUST
  use the typed work port.
- When the work store is `unavailable`, delivery MUST defer and MUST NOT be
  recorded as delivered; `unavailable` MUST NOT be treated as `missing`.
- Cross-store report delivery MUST reference the shared storage outbox/receipt
  protocol once available and MUST NOT define a second generic outbox. This
  feature MUST NOT create or edit any storage spec subtree.
- Public report CLI/SDK return contracts MUST remain concrete. `@CliOnly()` and
  weak return-schema baseline expansion MUST NOT be used to avoid schemas.

## Failure Matrix — Report Delivery

Source intent is the durable task event plus delivery intent (work). The core
receipt is the durable enqueue receipt/acknowledgement (core).

| Scenario | Source (work) state | Core state | Retry | Idempotency | Repair evidence |
| --- | --- | --- | --- | --- | --- |
| Crash before source commit | no task event / no delivery intent | no receipt | none; nothing to deliver | fresh key only after event commits | none |
| Crash after source commit, before core request | delivery intent pending | no receipt | re-request enqueue with same key | same key + hash is safe replay | pending intent row |
| Crash after core receipt, before source marks delivered | delivery intent pending | receipt exists | reconcile intent to receipt | dedupe by receipt id + key | orphan receipt reconciled |
| Timeout, unknown remote result | delivery intent `timed_out` | receipt/ack unknown | retry same key after backoff | replay dedupes on key + hash | timeout marker + attempts |
| Replay after acknowledgement loss | delivery intent pending | receipt exists, ack lost | re-check ack; do not re-render new payload | same key + hash idempotent | ack ledger by key |
| Payload-hash mismatch for existing key | `payload_conflict` | receipt for prior hash | blocked until repair | conflicting hash fails closed | conflict record with both hashes |
| Source (work) store unavailable | `unavailable` | n/a | defer; not delivered | no state change | unavailable read logged |
| Core (session) store unavailable | delivery intent pending | enqueue fails/unknown | retry with same key | no false delivered | enqueue failure evidence |
| Unsupported renderer/protocol version | intent with unsupported version | receipt refused | no blind retry; escalate | `unsupported` never counts as delivered | version mismatch record |

## Invariants

- Chat text alone MUST NOT be considered durable task progress.
- A terminal task state change MUST go through the task runtime.
- Report delivery MUST be explicit; absence of `reportToSessionName` means no report prompt is published.
- Report delivery MUST use effective assignment values before task-level values.
- Report prompts MUST be generated from task/profile/artifact context, not hardcoded assumptions about `TASK.md`.
- Report delivery MUST NOT publish for task event types outside the effective `reportEvents` set.
- The worker for `observed-task` MUST NOT be burdened with default task-sync protocol.
- Observer task-status mutation MUST be authorized by the observer runtime context, not by the source worker context.

## Acceptance Criteria

- `ravi tasks report` rejects empty progress messages.
- `ravi tasks done` rejects missing summaries.
- `ravi tasks block` rejects missing blocker reasons.
- `ravi tasks fail` rejects missing failure reasons.
- `task.blocked`, `task.done`, and `task.failed` can publish report prompts when a report target and matching report event are configured.
- A task without a report target does not publish report prompts.
- `observed-task` workers can avoid direct task-sync commands while a task-status observer owns durable synchronization.
- A report delivery idempotency key derived from the task event, target session, and renderer/protocol version prevents duplicate report prompts on replay.
- A payload-hash conflict for an existing report key fails closed with repair evidence instead of delivering a divergent prompt.
- Report delivery defers rather than being marked delivered when the work store is unavailable.

## Validation

- `bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts`
- `bun test src/tasks/notify.test.ts src/tasks/checkpoint-runner.test.ts`
- `bun test src/runtime/observation-plane.test.ts src/runtime/observation-profiles.test.ts`
- `bun run typecheck`

## Known Failure Modes

- A worker says "done" in chat but no durable task state changes.
- Report prompts are sent to a session even though no explicit report target was configured.
- Assignment-level report settings are ignored in favor of stale task-level settings.
- `TASK.md` frontmatter is required for a profile that does not use task documents.
- Duplicate observer deliveries create duplicate task reports or repeated terminal mutations.
- Observer sessions inherit source tools or channel authority unintentionally.
- A report is marked delivered on enqueue attempt before a durable core receipt, so a crash or dropped acknowledgement loses or duplicates the report.
- An unavailable work store is treated as `missing`, so a report is dropped or re-delivered.
- A task-specific report outbox is built instead of referencing the shared storage outbox/receipt protocol.
