---
id: sessions/goals
title: Session Goals
kind: capability
domain: sessions
capability: goals
tags:
  - sessions
  - goals
  - runtime
  - budget
applies_to:
  - src/runtime/session-goals.ts
  - src/runtime/session-goals.test.ts
  - src/router/router-db.ts
  - src/cli/commands/sessions.ts
  - src/runtime/runtime-system-prompt.ts
  - src/prompt-builder.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Session Goals

## Intent and ownership

A Ravi session goal controls the goal of its selected runtime through a provider-neutral contract. The runtime owns execution, continuation, lifecycle, budget enforcement and token/time accounting. Ravi owns session identity, authorization, task/project links, and a confirmed SQLite projection for inspection and prompt context.

A local `active` row alone MUST NOT be treated as an executing goal. Commands MUST receive a successful runtime response before changing the projection. Providers without goal support MUST return an explicit unsupported error; no prompt-only fallback may claim success.

## Runtime contract

- `goal.get` returns `RuntimeGoal | null` from the runtime.
- `goal.set` accepts an optional objective, status, token budget, and `createOnly` flag. Status/budget-only updates omit the objective to preserve runtime accounting. `createOnly` retains any existing goal.
- `goal.clear` confirms removal and returns null.
- `goal.updated` carries confirmed native snapshots, including null for removal. The host applies these snapshots so native model tools and CLI commands converge on the same state.
- `RuntimeGoal` normalizes statuses to `active`, `paused`, `blocked`, `budget_limited`, `usage_limited`, or `complete`; timestamps use Unix milliseconds.
- `SessionRuntimeProvider.controlSession` is optional metadata-only control for a persisted unloaded runtime session. It MUST NOT load a thread or start inference. Provider-specific storage locators travel in opaque session params.
- Capabilities advertise supported operations. CLI and host MUST NOT branch on a specific provider name. Codex is the first adapter.

## Managed continuation

An active host turn uses the live runtime control handle. Setting or resuming a goal in an idle loaded runtime MUST first retire that handle, update persisted runtime state without inference, and then queue an input through the normal Ravi prompt path. This keeps automatic work associated with host delivery, trace, and attached chat output.

A confirmed active goal in a cold session uses the same managed wake path. Reads, pause, block, complete and clear MUST NOT start inference. A create-only request that retained an existing goal MUST NOT enqueue another prompt.

The session must already have an initialized provider session. A missing session id, changed provider override, invalid stored cwd, or starting runtime MUST fail explicitly without manufacturing local success.

The adapter owns native continuation. The host MUST NOT invent another provider turn after a physical turn completes. Pausing a goal stops future automatic continuation; it does not necessarily interrupt work already executing. Explicit input interruption remains the normal host/provider operation.

## Projection and metadata

`session_goals` holds one confirmed snapshot per Ravi session. Native objective/status/usage/timestamps replace the projected values. Task/project links and a CLI blocking reason are local annotations, preserved while the goal identity remains the same. A new objective/creation time generates a new local correlation id.

Native blocked snapshots may have no reason field. CLI `block` still requires a concrete reason, stores it locally after runtime confirmation, and clears it when the goal leaves blocked status.

Runtime usage MUST NOT also be incremented by CLI accounting. The legacy `account` action returns an actionable error. `goal get` refreshes current accounting.

The schema migration preserves existing rows, usage, links, indexes and cascading deletion while adding `usage_limited`. An old local row is a historical snapshot, not authorization to reactivate a native goal. Reading/resuming native state can replace that row; operators must explicitly set the desired objective when migrating a divergent local goal.

A provider reset creates a different native session and MUST NOT automatically restart a projected goal. A confirmed null snapshot clears the projection. Prompt sections are bounded and labeled as snapshots; complete/cleared goals produce no section.

## Authorization

Reads require session read access. Mutations require session modify access. The host scopes controls to the resolved Ravi session's provider id and native session id; a caller thread id cannot redirect a goal operation.

## Validation

Run `bun run test:runtime-goals`, `bun test src/cli/commands/sessions.test.ts`, typecheck, build, and the repository pre-push checks. Validate native automatic successor turns in a real managed Ravi session before release.
