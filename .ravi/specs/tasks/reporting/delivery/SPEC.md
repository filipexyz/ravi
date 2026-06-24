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
