---
id: sessions/goals/checks
title: "Session Goals — Checks"
kind: capability
domain: sessions
capability: goals
status: draft
normative: false
---

# Session Goals Checks

## Store Operations

- `replaceSessionGoal` creates or replaces a goal, resetting counters.
- `createSessionGoal` creates only if no goal exists; returns null if one does.
- `getSessionGoal` returns the current goal or null.
- `clearSessionGoal` deletes the goal and returns whether a row was deleted.

## Status Lifecycle

- A new goal starts as `active` (or `budget_limited` if budget is 0).
- `pause` transitions `active` -> `paused`. Does not affect `budget_limited`.
- `resume` transitions `paused` -> `active` (or `budget_limited` if over budget).
- `resume` transitions `blocked` -> `active` (or `budget_limited` if over budget).
- `block` transitions `active` -> `blocked` with a required reason.
- `block` transitions `paused` -> `blocked` with a required reason.
- `block` without a reason fails with an error.
- `complete` transitions `active`, `paused`, `blocked`, or `budget_limited` -> `complete`.
- `complete` is terminal — no transitions out.
- `budget_limited` cannot transition to `active`, `paused`, or `blocked`.

## Budget Accounting

- Token deltas increment `tokensUsed` and `timeUsedSeconds`.
- Exceeding `tokenBudget` transitions `active` -> `budget_limited` automatically.
- Zero deltas return `unchanged`.
- Accounting against non-active goals (by default) returns `unchanged`.

## Blocked State

- `blocked` requires `blockedReason` to be non-empty.
- `blockedReason` is cleared when transitioning out of `blocked`.
- `blocked` is not a budget state — it represents a concrete external impediment.

## Authorization

- `get` requires read access.
- Mutations require modify access, enforced via `canModifySession`.

## Prompt/Context Rendering

- Active goals render a bounded section in the system prompt.
- Paused, blocked, and budget-limited goals also render (agents should know their goal state).
- Complete goals do not render.
- No goal renders no section.
- The section includes goalId, objective (truncated), status, budget progress, and blockedReason if blocked.

## SDK Return Schema

- `sessions.goal` has a concrete `@Returns(zod)` schema.
- `sessions.goal` is NOT in `WEAK_PUBLIC_RETURN_COMMANDS_BASELINE`.

## Validation Commands

```bash
bun test src/runtime/session-goals.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/runtime/runtime-system-prompt.test.ts src/prompt-builder.test.ts
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun run typecheck
bun run build
```
