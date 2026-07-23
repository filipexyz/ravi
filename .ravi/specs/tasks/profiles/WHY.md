# Task Profiles Rationale

## Why Profiles Are Declarative Contracts

A task profile answers "how does this class of work get created, dispatched, resumed, rendered, and synchronized?" once, so individual tasks do not each reinvent process rules. Keeping the manifest declarative means a task pinned under an older snapshot stays explainable and resumable even when the live catalog changes.

## Why Runtime Defaults Live On The Profile

`runtimeDefaults` lets a process contract express the model, effort, and thinking that its work usually needs, while still allowing per-task and per-dispatch overrides. Resolving runtime per field (rather than as one blob) keeps the precedence predictable and avoids mutating the assigned session's persistent settings.

## Why Effort Is Validated, Not Silently Corrected

Effort is a small, closed vocabulary (`none|minimal|low|medium|high|xhigh|max|ultra`). Silently rewriting an unknown effort to the default hides typos and stale automation: a caller that asked for `ultr` would quietly run at `xhigh` and never learn. Failing clearly on unknown effort in CLI flags, task/dispatch overrides, and profile `runtimeDefaults` keeps invalid input visible, while an unset effort still resolves to the documented `xhigh` default so the common path stays ergonomic.

## Why Effort Stays Separate From The Model Selector

Model selectors identify a model; effort controls reasoning depth. Embedding effort into a model string (for example `gpt-5.6-sol ultra`) would create ambiguous, unvalidatable identifiers. Keeping them separate lets the runtime validate each independently and pass effort through to the provider as `model_reasoning_effort` without renaming the model.
