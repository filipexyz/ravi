# Task Profiles Checks

## Manifest Validation

- Profile validation MUST reject broken templates, invalid artifact definitions, and unresolved required inputs.
- Profile validation MUST reject `runtimeDefaults.effort` values outside `none|minimal|low|medium|high|xhigh|max|ultra`.
- Profile validation MUST accept `runtimeDefaults.effort` values of `max` and `ultra`.
- A template reference MUST provide exactly one of inline text or path.

## Runtime Defaults Resolution

- An unset effort MUST resolve to the runtime effort default `xhigh`.
- An unknown effort in a CLI flag, task/dispatch override, or profile default MUST fail clearly and MUST NOT silently fall back to the default.
- Runtime resolution MUST pick effort per field using the documented precedence.
- Session effort override MUST beat agent effort default for non-task turns and task/profile gaps.
- Task runtime selection MUST NOT mutate the assigned session's persistent model, effort, or thinking settings.

## Model Selector

- A model selector MUST NOT contain whitespace, so `gpt-5.6-sol ultra` fails as a single selector.
- Effort MUST remain separate from the model selector and MUST reach the provider as `model_reasoning_effort` without renaming the model.

## Snapshot Determinism

- Creating a task MUST pin the effective profile snapshot, state, inputs, and runtime defaults.
- A task created under an older snapshot MUST remain resumable when the live catalog changes.

## Model Preset Precedence Checks

- A profile runtime model default wins over an agent preset and is not rewritten
  when the preset changes.
- With no prompt/dispatch/task/profile/session model, an agent preset supplies
  the effective model reported as `modelSource=agent_preset` with the preset
  version.
- `bun test src/tasks/runtime-options.test.ts`
