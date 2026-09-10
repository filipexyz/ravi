---
id: sessions/goals/checks
title: "Session Goals — Checks"
kind: capability
domain: sessions
capability: goals
status: active
normative: false
---

# Session Goal Checks

- The host calls the selected runtime before projecting a goal or waking work.
- A provider with no goal capability fails without local mutation.
- A non-Codex fixture provider exercises the same host contract.
- Active runtime updates use the live control handle without another input.
- Idle activation retires the loaded runtime before metadata control, then uses managed prompt delivery.
- Cold reads and non-active mutations do not start inference.
- Pause/resume omit the objective and preserve usage and local links.
- Missing/malformed responses and rejected mutations cannot claim success.
- Native goal events and resume hydration update the projection.
- Native `usageLimited` and `budgetLimited` remain distinct normalized states.
- SQLite migration preserves existing usage, annotations, indexes and cascading deletion.
- Automatic successor turns stay attached until a terminal goal state, interruption or failure.
- CLI accounting fails instead of double-counting runtime usage.

```bash
bun run test:runtime-goals
bun test src/cli/commands/sessions.test.ts
bun run typecheck
bun run build
```
