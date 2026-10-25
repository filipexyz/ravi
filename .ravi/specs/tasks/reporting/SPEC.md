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

Tasks and assignments MAY carry a checkpoint interval. Any progress report resets the active assignment's checkpoint, whichever session sends it: a report from an observer or an operator shell resets the assignee's checkpoint, not a row of its own.

For a profile without the observer, a checkpoint reminder is a runtime prompt to the worker session that asks for status when a task has gone silent beyond its configured checkpoint window. Checkpoint reminders MUST NOT be treated as task completion, failure, or external report delivery. They are a worker-session nudge that should cause a normal progress, blocked, done, or failed update.

For a profile with the observer (`observer.enabled`), the worker MUST NOT receive checkpoint reminders. The checkpoint is a silence detector: it moves only on task mutations (a report, a status change), so a miss means the task recorded nothing for a whole interval (30 minutes unless the task or dispatch sets one). That alone does not say the worker stopped, so the stall message MUST come from the worker session's persisted turns since dispatch (`session_turns`, which survives a daemon restart), not from the in-memory runtime map: a turn that ended says the worker answered and the observer may not be reading it, measuring silence from the last report when there is one; a turn still running in this daemon says so, and one left `running` by a daemon that has since restarted says it may have died with it; only with no turn since dispatch does the message say the turn may be hung or the session gone. The event stays `task.stalled`. The first miss after activity records `task.stalled` and tells the report target once; later misses only record `task.checkpoint.missed`.

## Observer Integration

A task profile turns the built-in task observer on with `observer.enabled: true`; the system `default` and `observed-task` profiles do. Custom profiles without the field keep the worker-reported protocol.

The built-in task observer:

- is a binding of role `task-observer` and rule id `builtin:task-observer`, created at runtime launch for a session working an observed task, with no stored rule; a user rule in `report` mode on the same session takes precedence and the built-in one stays off;
- runs as the worker's agent on the profile's `observer.model`, or the provider's lightweight model (`haiku` on Claude, a mini or spark model on Codex);
- holds the single grant `none`, so it has no tools and no task grants;
- reads the worker's user prompts, full assistant replies, a one-line digest of each tool call and the turn terminal, at the end of each turn and every five minutes during a long turn (`pulse`);
- answers with one `<task-verdict>{...}</task-verdict>` block whose `status` is `unchanged`, `progress`, `blocked`, `done`, `failed` or `stopped`, with an optional `progress`, `message`, `checklist`, `missing` and `evidence`.

The runtime, not the observer, applies the verdict. It MUST apply a verdict only for the task the delivery was composed for, only while that task's active assignment is the source session, and only once per delivery id. Mutations go through the normal task runtime with actor `task-observer` and the observer session as session name, so they emit the same events and reports a CLI mutation would.

A `stopped` verdict on an end-of-turn read sends the worker one nudge (`task.nudged`, a typed `_taskRuntime` prompt) naming what is missing. A second stop without progress in between records `task.stalled` and tells the report target; there is no third message. Progress, or a checklist item newly done, resets the count.

Prompts the task runtime sends to other sessions (reports, stall notices, nudges) carry `_taskRuntime: { taskId, kind, event }` and break `[System]` markers inside worker- or observer-written text, so that text cannot pose as an internal command.

Other observers MAY still own task status synchronization when a rule delegates reporting. An observer that mutates task state through task commands MUST use its own permissions, and its reports MUST be grounded in source task events, source turn ids, or observed worker statements so duplicate delivery can be deduped or ignored.

## Invariants

- Durable task status MUST be changed through the task runtime.
- Reporting commands MUST validate required message, summary, blocker, or failure fields before mutation.
- Assignment-level report settings MUST override task-level report settings.
- Report event filtering MUST be explicit and auditable.
- A task without report delivery configuration MUST NOT publish report prompts to another session.
- Checkpoint reminders MUST be separate from terminal report delivery.
- Observer-driven status sync MUST NOT require the worker prompt to include the default task-sync protocol.
- A worker on an observed profile MUST NOT receive checkpoint reminders.
- The built-in task observer MUST NOT hold tools or task grants; its verdict is applied by the runtime, scoped to the observed task and assignee, once per delivery.
- The worker receives at most one observer nudge per stretch without progress.

## Acceptance Criteria

- Progress can be reported with a message and optional percentage.
- Done, blocked, and failed states require explanatory text.
- Report events can be filtered to a subset of blocked/done/failed.
- Assignment report settings override task report settings.
- Checkpoint reminders can be emitted without changing terminal task state.
- Observer-owned task reporting can update durable state without giving the worker extra sync burden.
- An observer's progress report resets the worker's checkpoint.
- A silent observed task reports `task.stalled` to its report target once.

## Validation

- `bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts`
- `bun test src/tasks/checkpoint-runner.test.ts src/tasks/notify.test.ts`
- `bun test src/tasks/observer.test.ts`
- `bun test src/runtime/observation-plane.test.ts`
- `bun run typecheck`

## Known Failure Modes

- Progress is only stated in chat and never persisted.
- A report target receives a prompt for an event outside the configured filter.
- Assignment report settings are ignored.
- Checkpoint reminders are confused with terminal report delivery.
- Observer status sync mutates a task without adequate permission or provenance.
