# Task Profiles Runbook

## Adding Or Editing A Profile

1. Define the manifest under a catalog source (`system`, `plugin`, `workspace`, or `user`).
2. Provide the required fields and any optional `runtimeDefaults`.
3. Keep templates either inline or as a single template file reference.
4. Run `ravi tasks profiles validate` to confirm the manifest parses.
5. Confirm the effective source with `ravi tasks profiles show <id> --json`.

## Setting Runtime Defaults

- Use `runtimeDefaults.model` for a provider-specific model selector with no whitespace.
- Use `runtimeDefaults.effort` with a value from `none|minimal|low|medium|high|xhigh|max|ultra`.
- Use `runtimeDefaults.thinking` with `off|normal|verbose`.
- Leave `effort` unset to inherit the runtime effort default `xhigh`.
- Do not embed effort in the model selector; set it in the `effort` field instead.

## Overriding Runtime At Create Or Dispatch

- `ravi tasks create ... --model <model> --effort <level> --thinking <mode>` pins a task override.
- `ravi tasks dispatch <task-id> --agent <agent> --effort <level>` pins a dispatch override.
- Per-field precedence is: dispatch/launch override, task override, profile defaults, session preference, agent default, global config, then the `xhigh` effort default.

## Diagnosing Rejected Runtime Input

- An unknown `--effort` value or `runtimeDefaults.effort` is rejected with a clear error; fix the value rather than expecting a fallback.
- A model selector with whitespace is rejected before config is written; remove the whitespace or move effort into `--effort`.
