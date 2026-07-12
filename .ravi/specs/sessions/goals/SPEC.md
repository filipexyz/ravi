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
status: draft
normative: true
---

# Session Goals

## Intent

A session goal is a durable objective attached to exactly one Ravi session. It expresses what the session is working toward, how much budget it may consume, and where it stands in a well-defined lifecycle. Goals are Ravi-native runtime state, persisted by session identity in SQLite and available to prompt/context building at runtime.

Goals exist so that sessions can track bounded, observable work without conflating the concept with tasks, crons, followups, or provider-native goal/stop behavior.

## Boundary

Session goals own:

- per-session objective text;
- lifecycle status and valid transitions;
- token/time budget accounting and budget-limited state;
- blocked state with required concrete reason;
- pause/resume semantics;
- completion;
- clear/reset;
- bounded prompt/runtime context representation;
- persistence in the `session_goals` table.

Session goals do NOT own:

- task assignment, dispatch, dependencies, or terminal state (owned by `tasks`);
- cron scheduling or wall-clock cadences (owned by `cron`);
- inactivity followups (owned by `sessions/followups`);
- provider session state, resume, or fork (owned by `runtime/session-continuity`);
- provider-native goal or stop-hook behavior (MAY inform design, MUST NOT be source of truth).

## Definitions

- `goal`: a durable objective bound to one session. One goal per session at a time.
- `goalId`: UUID identifying the current goal instance. Changes on replacement.
- `objective`: human-readable text describing what the session should accomplish. Max 4000 characters.
- `status`: lifecycle state of the goal. See Status Lifecycle below.
- `tokenBudget`: optional positive integer cap on token consumption.
- `tokensUsed`: accumulated token usage against the budget.
- `timeUsedSeconds`: accumulated wall-clock seconds of work.
- `blockedReason`: required text when status is `blocked`. Describes the concrete impediment or question.

## Status Lifecycle

Valid statuses: `active`, `paused`, `budget_limited`, `blocked`, `complete`.

### Valid Transitions

```
active -> paused          (pause)
active -> budget_limited  (automatic on budget exhaustion)
active -> blocked         (block with reason)
active -> complete        (complete)
paused -> active          (resume, if not over budget)
paused -> complete        (complete)
paused -> blocked         (block with reason)
blocked -> active         (unblock/resume)
blocked -> paused         (pause)
blocked -> complete       (complete)
budget_limited -> complete (complete)
```

### Transition Rules

- `budget_limited` MUST NOT transition to `active` or `paused` — the budget is exhausted.
- `budget_limited` MUST NOT transition to `blocked` — the limitation is already terminal for work.
- `complete` is terminal — no transitions out.
- `paused` -> `active` MUST check budget: if `tokensUsed >= tokenBudget`, the goal transitions to `budget_limited` instead.
- `blocked` MUST require a non-empty `blockedReason`. `blocked` MUST NOT be used merely because work is hard, slow, uncertain, or over budget.

## Budget Accounting

- `tokenBudget` is optional. When set, token accounting increments `tokensUsed`.
- When `tokensUsed >= tokenBudget` and the goal is `active`, it transitions to `budget_limited` automatically.
- Budget accounting against `paused`, `blocked`, or `complete` goals is a no-op by default.
- The `mode` parameter on `accountSessionGoalUsage` controls which statuses participate.

## Blocked State

- `blocked` requires a concrete `blockedReason` — a question, dependency, or impediment.
- `blockedReason` is stored in the `blocked_reason` column and cleared when transitioning out of `blocked`.
- Setting a goal to `blocked` without a reason MUST fail with a clear error.

## Clear/Reset Semantics

- `clear` deletes the goal row entirely. The session returns to having no goal.
- Session reset (via `ravi sessions reset`) does NOT automatically clear goals. Goals persist across session resets unless explicitly cleared.
- Replacing a goal (`set`) replaces the entire goal including `goalId`, resets `tokensUsed` and `timeUsedSeconds` to 0.

## Configuration and Policy

- Default status on creation: `active` (or `budget_limited` if budget is 0 or already exhausted).
- Goals are per-session, not per-agent. Different sessions for the same agent MAY have independent goals.
- `taskId` and `projectId` are optional cross-references for correlation. They do not imply task or project lifecycle coupling.

## Cross-Store References

Session goals are core runtime state and MUST remain core-owned. Under the
storage-by-workload split, tasks and projects become work-owned while sessions
and their goals stay in core. The `taskId` and `projectId` fields cross that
boundary and are governed here.

- Goals MUST remain in core storage. They MUST NOT be moved into work storage.
- `taskId` and `projectId` MUST remain opaque optional references. They MUST NOT
  be implemented as cross-store foreign keys and MUST NOT participate in a
  cross-store cascade.
- Reading, creating, replacing, accounting, or rendering a goal MUST NOT require
  a work-store owner lookup. The reference is stored and displayed as-is.
- A missing work record (an unknown or deleted `taskId`/`projectId`) MUST NOT
  delete, complete, block, or otherwise mutate the goal. The reference MAY
  simply be unresolved.
- Work-store `unavailable` state MUST NOT prevent core from reading or
  accounting a goal, and MUST NOT be treated as `missing`. Goal budget
  accounting and lifecycle continue from core-only state.
- Any future resolution of `taskId`/`projectId` to work details MUST go through
  the typed work port and MUST tolerate `found`, `missing`, `unavailable`, and
  `unsupported` without mutating goal state.

## Authorization

- Reading a goal (`get`) requires session read access.
- Mutating a goal (`set`, `create`, `pause`, `resume`, `block`, `complete`, `clear`, `account`) requires session modify access.
- Authorization is enforced consistently with other session mutations via `canModifySession`.

## Persistence and Migration

- Goals are stored in the `session_goals` table with `session_key` as PRIMARY KEY and `ON DELETE CASCADE` from `sessions`.
- The `blocked` status is added to the CHECK constraint alongside existing statuses.
- The `blocked_reason` column is added as nullable TEXT. It MUST be non-null when `status = 'blocked'`.
- Existing rows are preserved. Existing data has no `blocked` rows, so no data migration is needed — only a schema migration (ALTER TABLE).

## Prompt/Runtime Context Representation

- Active goal state MUST be available to runtime prompt/context building.
- The representation MUST be bounded: objective text (truncated if needed), status, budget progress.
- The prompt section uses id `session.goal` with priority 23 (between operational context and workspace instructions).
- Goals in terminal states (`complete`) or cleared goals produce no prompt section.
- The representation is traceable: it includes the `goalId` for correlation.

## SDK Return Schema

- `sessions.goal` MUST expose a concrete `@Returns(zod)` schema describing the goal mutation envelope.
- The schema includes `action`, `changed`, `session` (loose object), and `goal` (structured nullable object with known fields).
- This removes `sessions.goal` from the weak return-schema baseline.

## Invariants

- At most one goal per session at any time.
- `goalId` is a UUID, generated on create/replace.
- `objective` is required, non-empty, max 4000 characters.
- `blockedReason` is required when `status = 'blocked'`, null otherwise.
- `tokenBudget`, when set, MUST be a positive integer.
- `tokensUsed` and `timeUsedSeconds` are non-negative integers.
- `taskId` and `projectId` are opaque optional references with no cross-store foreign key or cascade.
- A missing or unavailable work record MUST NOT mutate goal state.
- Work-store unavailability MUST NOT block reading or accounting a goal.

## Validation

```bash
bun test src/runtime/session-goals.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/runtime/runtime-system-prompt.test.ts src/prompt-builder.test.ts
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun run typecheck
bun run build
```
