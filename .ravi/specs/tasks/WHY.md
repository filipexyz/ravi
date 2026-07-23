# Tasks Rationale

## Why Tasks Are Durable Runtime Objects

Tasks exist so Ravi can track work independently from a chat message, a
provider session, or a single document artifact. The durable task row carries
lifecycle, assignment, dependency, profile, and runtime override state while
artifacts hold the richer body of work.

Keeping this split prevents a task from being accidentally redefined by a
renderer, a prompt template, or a `TASK.md` file. A document can describe the
work, but DB state and task events remain authoritative.

## Why Runtime Overrides Stay Task-Scoped

Task-level model, effort, and thinking overrides are execution inputs for a
specific dispatched task. They must not mutate the assigned session or agent,
because those defaults may be shared by later turns that are unrelated to the
task.

This keeps task execution reproducible while preserving normal session
continuity outside task-bound work.
