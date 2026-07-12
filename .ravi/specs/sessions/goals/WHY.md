---
id: sessions/goals/why
title: "Session Goals — Why"
kind: capability
domain: sessions
capability: goals
status: draft
normative: false
---

# Why Session Goals Exist

## Problem

Sessions need a way to express what they are working toward. Without a native goal primitive:

- Agents have no bounded, inspectable representation of their current objective.
- Budget enforcement is ad hoc or missing — sessions run until interrupted or context-limited.
- There is no lifecycle for pausing, blocking, or completing an objective.
- Runtime prompt building cannot include a traceable current-objective section.
- The `sessions.goal` SDK surface exposes a weak return schema.

## Decision

Make session goals a first-class Ravi-native session runtime primitive with:

- durable persistence by session identity;
- a well-defined status lifecycle (`active`, `paused`, `budget_limited`, `blocked`, `complete`);
- budget accounting with automatic `budget_limited` transition;
- `blocked` state requiring a concrete reason (not merely "work is hard");
- bounded prompt/runtime context rendering;
- concrete SDK return schema.

## Why Not Tasks

Tasks own tracked execution with dispatch, dependencies, reports, and terminal state. Goals are simpler: one objective per session, no dependency graph, no dispatch. A goal MAY reference a task via `taskId`, but it does not replace the task lifecycle.

## Why taskId/projectId Stay Opaque Across Stores

Goals live in core session storage, but they may reference a task or project
that, after the storage-by-workload split, lives in work storage. If those
references were cross-store foreign keys, a goal read would depend on the work
store being reachable, and deleting a task could cascade into deleting or
mutating a goal. Both are unacceptable: a session should still be able to state
and account its objective even when the work store is degraded or a referenced
task no longer exists.

Keeping `taskId`/`projectId` as opaque optional strings — no cross-store FK, no
cascade, no required owner lookup — means goal lifecycle and budget accounting
depend only on core state. A missing work record leaves the reference merely
unresolved; an unavailable work store never blocks the goal. This is the same
`found|missing|unavailable|unsupported` discipline the core/work protocol uses
everywhere, applied to a correlation reference rather than a control edge.

## Why Not Provider-Native Goals

Provider-native goal or stop-hook behavior (e.g., Codex goals, Claude `/goal`) MAY inform the design. But Ravi MUST own the canonical goal state so it works consistently across providers and survives provider session resets.

## Why Not Crons or Followups

Crons are wall-clock schedules. Followups are inactivity cadences. Goals are bounded objectives with lifecycle states. Different primitives for different jobs.

## Tradeoff

Adding a lifecycle to goals increases the surface area of session state. The cost is justified because it gives agents and operators a single inspectable, enforceable place to understand what a session is doing and whether it should keep going.
