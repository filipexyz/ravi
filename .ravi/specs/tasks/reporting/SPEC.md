---
id: tasks/reporting
title: "Task Reporting"
kind: capability
domain: tasks
capability: reporting
capabilities:
  - progress
  - terminal-state
  - report-targets
  - checkpoints
  - observer-status
tags:
  - tasks
  - reporting
  - status
  - observers
  - sessions
applies_to:
  - src/tasks/service.ts
  - src/tasks/session-publisher.ts
  - src/tasks/checkpoint-runner.ts
  - src/tasks/types.ts
  - src/cli/commands/tasks.ts
  - src/cli/commands/tasks-automations.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Task Reporting

## Intent

Task Reporting is the task runtime capability for turning execution state into durable task progress, terminal state, checkpoint reminders, and optional report prompts.

The capability exists to keep task status reliable even when worker sessions communicate through ordinary chat, observers, automations, or external executors.

## Scope

Task Reporting owns:

- progress updates through `ravi tasks report`;
- terminal transitions through `done`, `block`, and `fail`;
- report target selection through task-level and assignment-level report settings;
- report event filtering;
- checkpoint reminder metadata and missed-checkpoint events;
- observer-compatible task status synchronization.

Task Reporting does not own:

- task profile prompt rendering, except report message templates exposed by profiles;
- external channel delivery;
- workflow node state mapping;
- provider session lifecycle.

## Report State

Task status updates MUST be durable task runtime mutations, not just chat text.

Progress reporting MUST carry a descriptive message. Terminal reporting MUST carry the summary, blocker, or failure reason that explains the state change.

Task report state MAY be sourced from a profile artifact such as `TASK.md` when the profile uses that artifact. Profiles that do not use task documents MUST rely on explicit CLI arguments or an authorized observer/tool call.

## Report Events

The canonical report-event filter values are:

- `blocked`;
- `done`;
- `failed`.

Report events MAY be configured at task creation or dispatch. Assignment-level values MUST win over task-level values for the active assignment.

## Checkpoints

Tasks and assignments MAY carry a checkpoint interval. A checkpoint reminder is a runtime prompt to the worker session that asks for status when a task has gone silent beyond its configured checkpoint window.

Checkpoint reminders MUST NOT be treated as task completion, failure, or external report delivery. They are a worker-session nudge that should cause a normal progress, blocked, done, or failed update.

## Observer Integration

Observers MAY own task status synchronization when a profile explicitly delegates reporting.

An observer that mutates task state MUST use normal task mutation commands or runtime APIs with its own permissions. Observer reports MUST be grounded in source task events, source turn ids, or observed worker statements so duplicate delivery can be deduped or ignored.

## Invariants

- Durable task status MUST be changed through the task runtime.
- Reporting commands MUST validate required message, summary, blocker, or failure fields before mutation.
- Assignment-level report settings MUST override task-level report settings.
- Report event filtering MUST be explicit and auditable.
- A task without report delivery configuration MUST NOT publish report prompts to another session.
- Checkpoint reminders MUST be separate from terminal report delivery.
- Observer-driven status sync MUST NOT require the worker prompt to include the default task-sync protocol.

## Acceptance Criteria

- Progress can be reported with a message and optional percentage.
- Done, blocked, and failed states require explanatory text.
- Report events can be filtered to a subset of blocked/done/failed.
- Assignment report settings override task report settings.
- Checkpoint reminders can be emitted without changing terminal task state.
- Observer-owned task reporting can update durable state without giving the worker extra sync burden.

## Validation

- `bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts`
- `bun test src/tasks/checkpoint-runner.test.ts src/tasks/notify.test.ts`
- `bun test src/runtime/observation-plane.test.ts`
- `bun run typecheck`

## Known Failure Modes

- Progress is only stated in chat and never persisted.
- A report target receives a prompt for an event outside the configured filter.
- Assignment report settings are ignored.
- Checkpoint reminders are confused with terminal report delivery.
- Observer status sync mutates a task without adequate permission or provenance.
