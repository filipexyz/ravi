# Tasks Checks

## Runtime State Checks

- Task creation MUST persist the resolved profile id, version, source,
  snapshot, and input payload before dispatch.
- Dispatch MUST apply task-level model, effort, and thinking overrides without
  mutating the assigned session defaults.
- A turn without task binding MUST NOT inherit stale `RAVI_TASK_*` environment
  from previous task work.
- `show` and `watch` MUST be side-effect free and MUST NOT materialize missing
  task artifacts.
- `report`, `done`, `block`, and `fail` MUST update durable task state and task
  events through the task runtime.
- A comment on a blocked task whose session is gone MUST recreate the session
  under the assigned agent when that agent still exists (otherwise the task
  stays blocked) and steer it with that agent and the task binding; a
  session owned by another agent MUST leave the task blocked with a "not
  steered" reason, and dispatch into it MUST fail with
  `TASK_SESSION_OWNERSHIP_CONFLICT` before resuming (`src/tasks/comment-steer.test.ts`).

## Commands

- `bun test src/tasks/service.test.ts src/tasks/runtime-options.test.ts`
- `bun test src/cli/commands/tasks.test.ts src/cli/commands/tasks-profiles.test.ts`
