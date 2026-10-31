# Tasks Checks

- `bun test src/tasks/worker-session-authorization.test.ts` MUST reject an
  unauthorized same-agent worker by name and key, including with read access;
  CLI/stream create leave no task, dispatch leaves no assignment or prompt,
  and deferred work leaves no launch plan. Resolved default targets are checked
  even in previews. Current sessions and explicit modify grants remain allowed.

## Runtime State Checks

- Task creation MUST persist the resolved profile id, version, source,
  snapshot, and input payload before dispatch.
- Dispatch MUST apply task-level model, effort, and thinking overrides without
  mutating the assigned session defaults.
- Entering or leaving a task on a live session applies its effort and thinking
  to that turn without relaunching the runtime.
- A turn without task binding MUST NOT inherit stale `RAVI_TASK_*` environment
  from previous task work.
- A task-less prompt that is not `after_task` and reaches a session with a
  `dispatched` or `in_progress` assignment runs with that task's binding; a
  `blocked`, done or failed task is not inherited
  (`src/runtime/session-dispatcher.test.ts`, "task-bound live sessions").
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
- [ ] Dispatch into the name of an open Slack thread whose session is gone, or
  whose name resolves under another key, MUST fail with
  `TASK_SESSION_THREAD_IDENTITY_CONFLICT` and write no session or assignment;
  assignee resolution MUST not recreate it; dispatch into the thread's own
  session MUST work (`src/tasks/dispatch-thread-identity.test.ts`,
  `src/router/thread-identity.test.ts`).

## Commands

- `bun test src/tasks/service.test.ts src/tasks/runtime-options.test.ts`
- `bun test src/cli/commands/tasks.test.ts src/cli/commands/tasks-profiles.test.ts`

- Run `bun test src/tasks/thread-core.test.ts src/runtime/prompt-subscription.test.ts` in isolated state to verify channel-free creation and assignment admission.
