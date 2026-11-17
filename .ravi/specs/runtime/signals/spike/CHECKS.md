---
id: runtime/signals/spike/checks
title: "Signals Spike Checks"
kind: checks
domain: runtime
capability: signals
feature: spike
status: draft
normative: true
---

# Signals Spike Checks

```bash
bun test src/signals/
bun test src/runtime/delivery-queue.test.ts -t "signal"
bun test src/cli/commands/signals.test.ts
```

## Probe

- `host.disk` returns `path`, `free_pct`, `free_bytes`, `total_bytes`, `checked_at`.
- `free_pct` uses `bavail`, not `bfree`.
- `total_bytes=0` is an error, not 0% free.
- probe timeout is <= 1s and does not block turn start beyond the bound.
- cache is honored for 60s and invalidated by tests.

## Producer

- below 15% -> one open signal;
- below 15% on ten ticks -> one row;
- above 20% for the grace window -> resolved;
- above 20% for less than grace -> still open;
- watcher stopped -> TTL expiry, not false resolve;
- duplicate watcher runs -> one row.

## Piggyback

- next turn includes exactly one item;
- no turn is created by the signal;
- 25% probe -> no block, resolved;
- 9.2% probe but muted -> no block;
- cooldown active -> no block;
- budget exhausted -> held line, no item.

## Escalation

- tick dry-run -> no outbound, no prompt, no surface row;
- tick execute -> one deterministic line, one prompt, one surface row;
- cleared before tick -> nothing sent;
- acked within renotify -> no repeat;
- resolved -> no repeat;
- two concurrent ticks -> one delivery;
- no chat binding -> prompt still published, line skipped and logged;
- page cap 3 -> stops.

## Restart

Restart between raise and tick; restart between tick and ack; no duplicate surface after restart.

## Observer Regression (v5 Probe)

- `archived_at != null` + `status=in_progress` -> no signal; existing signal resolves `subject_terminal`.
- ended ephemeral session + task `in_progress` -> no signal; existing signal resolves.
- `in_progress` + `turn_active=false` + `pending_count=0` -> `task.orphaned`, `kind=fact`, `severity=piggyback`, no OOB.
- `in_progress` + `turn_active=true` + no progress -> `task.stalled`, `kind=judgment`, `severity=piggyback`, no OOB.
- `in_progress` + `pending_count>0` -> no stall signal.
- stored `severity=interrupt` on an observer judgment -> delivery clamps to `piggyback` and records `ceiling_clamped`.
- task reaches terminal state -> both signals resolve on next evaluation.
- orphan `max_surfaces=1` -> at most one block item, never a page.
- raise over archived task -> `ENTITY_TERMINAL`, no row.
- raise before archive, archive, tick -> no page, resolved, zero surface.

## Kill Switch

With `signals.enabled=false`:

- no block in the next turn;
- tick delivers nothing;
- `explain` reports disabled.
