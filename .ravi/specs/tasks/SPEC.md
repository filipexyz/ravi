---
id: tasks
title: "Tasks"
kind: domain
domain: tasks
capabilities:
  - profiles
  - lifecycle
  - dispatch
  - reporting
  - dependencies
  - automations
tags:
  - tasks
  - runtime
  - agents
  - profiles
  - artifacts
  - events
applies_to:
  - src/tasks
  - src/cli/commands/tasks.ts
  - src/cli/commands/tasks-profiles.ts
  - src/cli/commands/tasks-deps.ts
  - src/cli/commands/tasks-automations.ts
  - docs/ravi-task-runtime-v0.md
  - docs/task-profiles-catalog-v1.md
owners:
  - ravi-dev
status: active
normative: true
---

# Tasks

## Intent

The Tasks domain is Ravi's operational control plane for tracked work distributed across agents and sessions.

A task is a durable lifecycle object. A task profile is the process contract. Artifacts carry the rich body of work. Sessions execute turns. The task runtime coordinates those surfaces without collapsing them into one Markdown file or prompt convention.

## Boundaries

Tasks own:

- task lifecycle: `open`, `dispatched`, `in_progress`, `blocked`, `done`, and `failed`;
- assignment, dispatch, comments, archive/unarchive, dependencies, and automations;
- task events and task stream snapshots;
- profile resolution at creation and dispatch time;
- task-level runtime overrides for model, effort, and thinking;
- explicit progress, blocked, done, and failed state synchronization.

Tasks do not own:

- provider session continuity;
- external channel delivery semantics;
- agent configuration, cwd, or permissions;
- workflow graph semantics, except task nodes attached to workflow runs;
- observer prompt rendering, except selecting task/profile metadata that observers may consume;
- the contents of every artifact beyond the profile contract that declares it.

## Core Model

- `task` = lifecycle object and durable substrate.
- `profile` = declarative process contract.
- `artifact` = body of work, such as `TASK.md`, a report, or a domain-specific file.
- `session` = execution context for one agent.
- `worktree` = contextual workspace hint; it MUST NOT replace the agent/session cwd.
- DB and events = authoritative task state substrate.

`TASK.md` is not the task. It is only an artifact used by profiles that declare it.

## Invariants

- The task runtime MUST resolve a profile before create or dispatch can apply profile-specific behavior.
- Unknown profile ids MUST fail early. They MUST NOT silently fall back to `default`.
- Invalid profile templates, inputs, artifacts, workspace bootstrap, or runtime defaults MUST fail before durable side effects when possible.
- Task creation MUST persist the resolved profile id, version, source, snapshot, initial state, and input payload for that task.
- Updating the live profile catalog MUST NOT silently mutate old tasks that already pinned a profile snapshot.
- `TASK.md` MUST only be materialized, displayed, or required when the effective profile contract declares task-document usage.
- `show` and `watch` MUST be side-effect free. They MUST NOT create `TASK.md` or mutate task state.
- Dispatch MUST resolve the effective session cwd from the assigned agent/session. Worktree metadata MAY add context but MUST NOT override cwd.
- A task-linked runtime turn MAY receive `RAVI_TASK_*` environment only when the turn is explicitly bound to a dispatched or resumed task.
- Turns without a task binding MUST NOT inherit stale `RAVI_TASK_*` state from earlier task work.
- Task-level and dispatch-level runtime overrides MUST NOT be implemented by mutating session model or thinking preferences.
- Reporting, blocking, completing, and failing a task MUST write through the task runtime so DB state and task events stay authoritative.
- External channel messages are not the task runtime's primitive. If a task report needs to reach a person or session, it MUST use the explicit report delivery path.

## CLI Surface

Canonical task runtime commands:

```bash
ravi tasks create "..." --instructions "..." --profile <id>
ravi tasks dispatch <task-id> --agent <agent>
ravi tasks show <task-id>
ravi tasks watch <task-id>
ravi tasks report <task-id> --message "..."
ravi tasks done <task-id> --summary "..."
ravi tasks block <task-id> --reason "..."
ravi tasks fail <task-id> --reason "..."
```

Canonical profile catalog commands:

```bash
ravi tasks profiles list
ravi tasks profiles show <profile-id>
ravi tasks profiles preview <profile-id> --title "..." [--input k=v]
ravi tasks profiles validate [profile-id]
ravi tasks profiles init <profile-id> --preset <doc-first|brainstorm|runtime-only|content>
```

## Acceptance Criteria

- A task can be created with a resolved profile and a pinned profile snapshot.
- A task can be dispatched to an agent session without mutating that session's default model settings.
- `show` and `watch` can render profile, workspace, assignment, artifacts, dependencies, and history without materializing missing artifacts.
- `report`, `done`, `block`, and `fail` update durable task state and emit task events.
- A profile that does not use `TASK.md` can run without task-document side effects.
- A task with dependencies can defer dispatch until readiness is satisfied.

## Validation

- `bun test src/tasks/service.test.ts src/tasks/task-db.test.ts src/tasks/runtime-options.test.ts`
- `bun test src/tasks/profiles.test.ts src/cli/commands/tasks.test.ts src/cli/commands/tasks-profiles.test.ts`
- `bun test src/tasks/automations.test.ts src/tasks/checkpoint-runner.test.ts`
- `bun run typecheck`

## Known Failure Modes

- Treating `TASK.md` as the task source of truth and bypassing DB/events.
- Falling back to `default` when a requested profile is missing.
- Changing a profile and accidentally changing old task behavior that should be snapshot-pinned.
- Using `ravi sessions set-model` to implement task runtime overrides.
- Reading or writing stale task context in a later non-task turn.
- Reporting task progress only in chat without mutating durable task state.
- Making `show` or `watch` create files as a display side effect.
