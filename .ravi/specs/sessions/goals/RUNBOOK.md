---
id: sessions/goals/runbook
title: "Session Goals — Runbook"
kind: capability
domain: sessions
capability: goals
status: draft
normative: false
---

# Session Goals Runbook

## Set a Goal

```bash
ravi sessions goal set <session> "Implement the new feature" --budget 50000
```

Creates or replaces the goal for the session. Resets token/time counters.

## Get Current Goal

```bash
ravi sessions goal get <session> --json
```

Returns the current goal state including status, budget, and usage.

## Block a Goal

```bash
ravi sessions goal block <session> --reason "Waiting for API credentials from the user"
```

Transitions the goal to `blocked`. Requires a concrete reason.

Do NOT use `blocked` for:
- work that is merely hard or slow;
- uncertainty about approach;
- being over budget (that is `budget_limited`).

## Unblock a Goal

```bash
ravi sessions goal resume <session>
```

Transitions a `blocked` goal back to `active` (respecting budget limits).

## Pause/Resume

```bash
ravi sessions goal pause <session>
ravi sessions goal resume <session>
```

Pause suspends active work. Resume reactivates — unless the goal is over budget, in which case it transitions to `budget_limited`.

## Complete a Goal

```bash
ravi sessions goal complete <session>
```

Marks the goal as complete. Terminal state.

## Clear a Goal

```bash
ravi sessions goal clear <session>
```

Removes the goal entirely. The session returns to having no goal.

## Diagnose Budget-Limited

If a goal is `budget_limited`:

1. Check `tokensUsed` vs `tokenBudget` in `ravi sessions goal get <session> --json`.
2. The goal cannot be resumed or paused — the budget is exhausted.
3. Options: `complete` (accept the work done) or `clear` and set a new goal with a larger budget.

## Diagnose Blocked

If a goal is `blocked`:

1. Check `blockedReason` in `ravi sessions goal get <session> --json`.
2. Resolve the impediment.
3. Resume with `ravi sessions goal resume <session>`.

## Inspect Goal in Runtime Prompt

Active, paused, blocked, and budget-limited goals appear in the runtime system prompt under "Session Goal". The section includes the objective, status, and budget progress. Complete or cleared goals do not appear.
