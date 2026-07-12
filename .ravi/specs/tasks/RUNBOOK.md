# Tasks Runbook

## Inspecting Tasks

1. `ravi tasks show <task-id>` displays the durable task state, assignment,
   profile snapshot, artifacts, dependencies, and recent events.
2. `ravi tasks watch <task-id>` follows task progress without mutating state.
3. `ravi tasks profiles show <profile-id>` inspects the profile contract used
   to create or dispatch work.

## Dispatching With Runtime Overrides

1. Create or inspect the task and confirm the resolved profile.
2. Dispatch with the intended agent/session and optional runtime overrides.
3. Verify that task-bound turns receive only task-scoped runtime options.
4. Confirm that the assigned session's default model, effort, and thinking
   settings did not change after dispatch.

## Diagnosing State Drift

If chat output and task state disagree, trust the task DB and task events first.
Use `report`, `done`, `block`, or `fail` to bring durable state back in sync
instead of treating a chat message as the source of truth.
