---
id: tasks/profiles
title: "Task Profiles"
kind: capability
domain: tasks
capability: profiles
capabilities:
  - profile-catalog
  - profile-snapshot
  - workspace-bootstrap
  - artifacts
  - templates
  - runtime-defaults
  - inputs
tags:
  - tasks
  - profiles
  - artifacts
  - templates
  - runtime
applies_to:
  - src/tasks/profiles.ts
  - src/tasks/profile-catalog/system-profiles.json
  - src/cli/commands/tasks-profiles.ts
  - src/tasks/profiles.test.ts
  - docs/task-profiles-catalog-v1.md
owners:
  - ravi-dev
status: active
normative: true
---

# Task Profiles

## Intent

Task Profiles are declarative contracts for how one class of task should be created, dispatched, resumed, rendered, and synchronized.

The profile catalog answers "which process contracts are available?". A profile answers "how does this process work?".

## Profile Model

A task profile MUST define:

- stable `id`;
- `version`;
- `label` and `description`;
- `sessionNameTemplate`;
- `workspaceBootstrap`;
- `sync`;
- `rendererHints`;
- `defaultTags`;
- `inputs`;
- `completion`;
- `progress`;
- `artifacts`;
- `state`;
- `templates`.

A profile MAY define `runtimeDefaults` for `model`, `effort`, and `thinking`.

Templates MAY be inline strings or local template file references. A template reference MUST provide exactly one of inline text or path.

## Catalog Sources

The resolved catalog uses this source precedence:

1. `system`
2. `plugin`
3. `workspace`
4. `user`

Later sources override earlier sources for the same profile id. The effective source MUST be visible in profile list/show output so operators can diagnose which contract won.

## Snapshot and Determinism

When a task is created, Ravi MUST pin:

- `profile_id`;
- `profile_version`;
- `profile_source`;
- `profile_snapshot_json`;
- `profile_state_json`;
- `profile_input_json`.

The snapshot MUST include runtime defaults, artifacts, templates, inputs, state defaults, sync policy, and renderer hints needed to run the task later.

A task created under an older profile snapshot MUST remain explainable and resumable even when the live catalog changes.

## Runtime Defaults

`runtimeDefaults` MAY provide task-specific model, effort, and thinking defaults.

The effective runtime MUST be resolved per field using this precedence:

1. dispatch override or launch-plan override;
2. task override;
3. profile runtime defaults;
4. existing human session model/thinking preference;
5. agent default model;
6. global config model;
7. runtime effort default `xhigh`.

Invalid effort values MUST fall back to the runtime effort default.

Task runtime selection MUST NOT mutate the assigned session's persistent model or thinking settings.

## Inputs

Profile inputs define structured briefing fields.

- `--input key=value` MAY be repeated at task creation.
- Required inputs MUST block create, preview, or dispatch when empty.
- Optional declared inputs SHOULD be available as an empty string when omitted.
- Unknown template placeholders MUST fail early rather than render misleading output.

## Artifacts

Profiles declare the artifacts that carry the body of work.

- A profile MAY declare zero or more artifacts.
- At most one artifact SHOULD be primary for a given task surface.
- `TASK.md` is only a task artifact when the profile declares task-document usage.
- `show` and `watch` MUST resolve artifact metadata without creating missing files.

## System Built-ins

The current system catalog MUST expose these built-in profiles:

- `default`: doc-first profile where `TASK.md` is the primary artifact and the worker synchronizes status with `ravi tasks report|block|done|fail`.
- `observed-task`: doc-first profile where `TASK.md` is still the primary artifact, but the worker leaves clear progress/blocker/done/failure signals and a sidecar observer is expected to synchronize durable task status.

Other profiles MAY exist from plugin, workspace, or user catalogs. They MUST NOT be documented as system built-ins unless the resolved catalog exposes them with `sourceKind=system`.

## Invariants

- Profile manifests MUST be declarative process contracts, not imperative runtime code.
- Profile validation MUST reject broken templates, invalid artifact definitions, invalid runtime defaults, and unresolved required inputs.
- `preset` MUST remain a scaffold helper. Runtime behavior MUST come from the resolved profile manifest.
- Built-in profiles MUST be covered by tests that assert their ids and critical dispatch behavior.
- The profile catalog MUST be inspectable through `ravi tasks profiles list|show|preview|validate`.
- `observed-task` MUST NOT instruct the worker to call `ravi tasks report|block|done|fail` by default.
- `default` MUST instruct the worker to keep `TASK.md` useful and synchronize through the task CLI.

## Acceptance Criteria

- `ravi tasks profiles list --json` returns resolved profiles with ids, versions, source kinds, sources, artifacts, tags, and renderer hints.
- `ravi tasks profiles show <profile-id> --json` exposes the effective manifest.
- `ravi tasks profiles preview <profile-id>` renders create, dispatch, resume, and report templates with representative context.
- `ravi tasks profiles validate` fails for invalid manifests.
- Creating a task pins the effective profile snapshot, state, inputs, and runtime defaults.

## Validation

- `bun test src/tasks/profiles.test.ts src/cli/commands/tasks-profiles.test.ts`
- `bun test src/tasks/runtime-options.test.ts src/tasks/service.test.ts`
- `ravi tasks profiles validate`
- `bun run typecheck`

## Known Failure Modes

- Documenting stale built-ins that are no longer present in the resolved system catalog.
- Treating scaffold presets as runtime profiles.
- Rendering unknown placeholders as blank strings.
- Letting a profile edit silently alter behavior for already-created tasks.
- Accidentally requiring `TASK.md` for a profile that does not declare task-document usage.
- Putting observer status-sync instructions in the worker prompt for `observed-task`.
