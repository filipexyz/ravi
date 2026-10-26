---
id: runtime/signals/spike
title: "Signals Spike"
kind: feature
domain: runtime
capability: signals
feature: spike
capabilities:
  - signals
  - disk-signal
  - signal-piggyback
  - signal-escalation
tags:
  - runtime
  - signals
  - spike
  - mvp
  - disk
applies_to:
  - src/signals
  - src/runtime/delivery-queue.ts
  - src/runtime/runtime-request-builder.ts
  - src/cli/commands/signals.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Signals Spike

## Intent

Prove the whole signals primitive with one condition: `host.disk.free` below 15%. No catalog, no daemon-wide adoption, no UI. One fact, one close rule, one cooldown, and both delivery routes.

The spike succeeds when a real low-disk condition reaches the operator without waking anyone when a turn is about to happen, and still reaches the operator when nobody speaks.

## Scope

In scope:

- `host.disk` probe using `statfsSync` on the volume that backs the Ravi state directory;
- one fact signal `host.disk.free`;
- durable record, state machine, clear rule, cooldown, ack, resolve, mute;
- piggyback render into the next turn;
- `tick` escalation with `page` semantics, including the deterministic line;
- CLI: `raise`, `list`, `show`, `ack`, `resolve`, `mute`, `tick`, `explain`;
- tests for the full loop.

Out of scope:

- any other fact or judgment;
- Console UI, Pages, inbox integration;
- generic probe plugin loading;
- per-project or per-person policies;
- notifications outside the operator's bound chat;
- automatic remediation (deleting files, restarting daemons);
- enabling the feature in production without explicit operator approval.

## Canonical Anti-Noise Case: v5 Probe

This is the reference failure for the whole feature. It happened on 2026-10-21.

Timeline (UTC):

- 15:59:33 `task-b5569b39` ("obs v5 probe") created by bootstrap and dispatched on ephemeral session `v5-probe` with instruction "Responda apenas OK. Nao use ferramentas.";
- 15:59:39 the session turn completed in about six seconds;
- 16:01:38 the task was archived manually: "probe de validacao tool-first (arquivada)";
- 16:29:52 the observer fired `task.checkpoint.missed` and `task.stalled` and delivered an interrupt to the operator chat.

At raise time the task was already archived with `status=in_progress` (archiving does not change status), and the turn had been over for 30 minutes. The observer filtered only by `status=in_progress` and ignored `archived_at`, the ephemeral session state, and the runtime turn state.

Expected behavior under this spec:

1. **Archived means no signal.** `archived_at != null` is terminal for signal purposes even when `status=in_progress`. The producer raises nothing, and the terminal-subject guard resolves any existing task signal with `close_reason=subject_terminal`.
2. **Ended ephemeral session means no signal.** The task is not a live workload; a missing turn is not a stall.
3. The producer reads runtime state before raising. If the task were not archived, `turn_active=false` and `pending_count=0` means **orphaned**, not stalled.
4. The correct non-archived signal would be `task.orphaned.task-b5569b39`, a fact with low severity `piggyback`, `clear_when` = the task reaches a terminal state, `escalate_after_ms=null`, `max_surfaces=1`.
5. No interrupt, no page, no OOB turn.
6. If a turn happens, the orphan fact may appear once as context. It does not repeat and does not consume incident budget.
7. If the task later closes, the next evaluation resolves the orphan signal.
8. If the stored row is a judgment with `severity=interrupt` (legacy or bug), delivery clamps it to `piggyback`, records `ceiling_clamped`, and never interrupts.
9. A true `task.stalled` requires `turn_active=true` and no progress for `stall_after`, and is still a judgment: `piggyback`, never `interrupt`.

This case is a test fixture, not a second production condition. The spike ships the disk fact; the task observer regression guards class, structural, and resurrection rules.

## Signal Definition

## Signal Definition

| Field | Value |
| --- | --- |
| `key` | `host.disk.free` |
| `kind` | `fact` |
| `producer_type` | `code` |
| `producer_id` | `signals.watch.disk` |
| `scope` | `fleet` |
| `severity` | `page` |
| `title` | `Disk free below 15%` |
| `detail` | `<path>: <free_pct>% free (<free_gb> GB of <total_gb> GB)` |
| `evidence` | `{metric:"free_pct", value, threshold:15, path, total_bytes, free_bytes, checked_at}` |
| `clear_when` | `{"type":"probe","probe":"host.disk","expr":"free_pct >= 20","recheck_ms":300000,"grace_ms":600000}` |
| `cooldown_ms` | 6h |
| `renotify_after_ms` | 60m |
| `escalate_after_ms` | 0 |
| `max_surfaces` | 3 |
| `ttl_ms` | 24h |
| `reopen_after_ms` | 24h |

Why the gap between open (15%) and clear (20%): hysteresis prevents a flapping signal around the threshold. A disk at 16% is not healthy enough to auto-close, but it is not a new incident either.

## Probe

`host.disk` fields:

- `path` (string, the probed volume root);
- `free_pct` (number, 0–100, one decimal);
- `free_bytes` (number);
- `total_bytes` (number);
- `checked_at` (ISO timestamp).

Implementation notes:

- use `statfsSync` on the directory holding the Ravi state (`getRaviStateDir()`), falling back to `/`;
- `free_bytes = bavail * bsize`, `total_bytes = blocks * bsize`, `free_pct = free_bytes / total_bytes * 100`;
- hard timeout 1s (the call is synchronous and local, but wrap it so a hung filesystem cannot block a turn indefinitely);
- cache the last value for 60s to keep render cheap;
- no writes, no network, no shell.

## Producer

The spike uses one built-in watcher inside `signals tick`:

```text
on tick:
  read host.disk
  if free_pct < 15:
    raise host.disk.free (upsert; refresh evidence and last_seen_at)
  else if free_pct >= 20 and an open host.disk.free exists:
    resolve it after the clear grace window
```

Rules:

- the watcher is code, not a generic rule engine;
- it MUST be idempotent: ten ticks below threshold produce one signal, not ten;
- it MUST NOT raise while the signal is acknowledged and still true; it only refreshes evidence;
- it MUST NOT resolve on a single healthy reading; `clear_when.grace_ms` is authoritative;
- it MUST NOT run in the render path. Render only evaluates `clear_when`; opening is a tick responsibility.

A future generic watcher registry is explicitly out of scope for the spike.

## Route 1: Piggyback

On the next physical turn in the fleet session:

1. render evaluates `host.disk` (cache may satisfy it);
2. if `free_pct < 20`, the signal stays open and is eligible;
3. if not muted, not in cooldown, and budget remains, the block includes:

```text
[sig_...] FACT host.disk.free | page | open since 03:12Z | observed 14:01Z
  Disk free 9.2% on / (threshold 15%).
  closes when free_pct >= 20 (probe host.disk, recheck 5m, grace 10m)
  ack: ravi signals ack sig_...
```

4. surface accounting is written before the prompt is yielded;
5. no extra turn is created.

If no turn happens, nothing is delivered by this route. That is the intended economy, and the reason route 2 exists.

## Route 2: Out-of-band Escalation

`signals tick` runs every 5 minutes (shell cron, one owner):

1. refresh the disk fact;
2. find `host.disk.free` with `now - opened_at >= 0`, not muted, not acked within `renotify_after_ms`, no OOB in the last `cooldown_ms`;
3. write one `signal_surfaces` row with `route=oob` and an escalation bucket;
4. send the deterministic line through the channel outbound path to the fleet session's bound chat:

```text
⚠ Disk free below 15% — / has 9.2% free (observed 14:01Z). Ack: ravi signals ack <id>
```

5. publish an OOB prompt with `deliveryBarrier=immediate_interrupt` so the agent adds context, not the alert itself;
6. increment `escalation_count`.

If the disk clears before the tick, no OOB is sent and the signal resolves at the next evaluation.

If the deterministic line cannot be sent because the fleet session has no channel binding, the tick MUST log and still publish the OOB prompt; `explain` MUST show `deterministic_line=skipped_no_binding`.

## Escalation Timeline

```text
03:12  watcher sees 9.2% free -> raise (open)
03:12  (no turn, no delivery)
03:17  tick -> page line + interrupt prompt (first escalation)
03:22  no ack -> tick sees cooldown? no: renotify 60m, so no repeat yet
04:17  still open, still unacked -> repeat page (escalation 2)
05:03  operator acks -> acknowledged, repeats stop for 60m
06:03  still open -> re-surface piggyback (if a turn happens) or page again
14:00 operator returns, turn happens -> block is present if still open
```

The exact repeats are bounded by `max_surfaces=3` and `escalation_count<3`. An ignored page expires after 3 attempts and reopens only after 24h if the condition persists.

## Budget Interaction

- The piggyback surface counts against the daily 3-surface budget.
- The page bypasses the daily piggyback budget by policy, but is capped at 3 per signal and audited.
- The deterministic line and the OOB prompt are one logical escalation; they share one surface row, not two.
- A muted signal produces neither route.

## Failure Behavior

| Situation | Required behavior |
| --- | --- |
| `statfsSync` throws | keep signal open, render `unknown`, no page, record `eval_failed` |
| Probe returns implausible values (`total=0`, `NaN`) | treat as probe error, not as low disk |
| Watcher stops | signal expires at TTL, no false "resolved" |
| Tick stops | piggyback still works; no escalation; `signals tick` health is visible in `explain` |
| Two ticks overlap | lock prevents double delivery |
| Disk recovers between ticks | render resolves; tick sends nothing |
| Fleet session has no chat binding | OOB prompt still published; deterministic line skipped and logged |
| Budget exhausted | block shows held count; page still allowed |

## Implementation Plan

### Phase 1: store and CLI

Files:

- `src/signals/types.ts` — record, state, severity, clear rule types;
- `src/signals/signal-db.ts` — tables, indexes, upsert, transitions, surface ledger, budget queries;
- `src/signals/service.ts` — raise/update/ack/resolve/mute/list/show/explain;
- `src/signals/validation.ts` — key, scope, severity ceiling, clear rule grammar;
- `src/cli/commands/signals.ts` — command group;
- `src/cli/commands/index.ts` — register;
- tests: `model.test.ts`, `signal-db.test.ts`, `cli/commands/signals.test.ts`.

Done when a signal can be raised, listed, acked, resolved, muted, and read back after a daemon restart, with no delivery side effects.

### Phase 2: probe and piggyback

Files:

- `src/signals/probes.ts` — registry with `host.disk`, timeout, cache;
- `src/signals/render.ts` — selection, budget, block formatting, sanitization;
- `src/runtime/delivery-queue.ts` — add `transformTurnPrompt` to the generator options and use its return in the yielded prompt;
- `src/runtime/runtime-request-builder.ts` — wire the transform, pass session/agent/chat context, trace surfaced ids;
- tests: `probes.test.ts`, `render.test.ts`, `delivery-queue.test.ts` additions.

Done when a pre-seeded low-disk signal appears in the next turn, clears when the probe is healthy, and creates no turn on its own.

### Phase 3: tick and escalation

Files:

- `src/signals/tick.ts` — evaluation, expiry, escalation selection, lock, idempotency;
- `src/signals/page.ts` — deterministic line via `buildChannelTextOutboundJob` / `publishChannelOutboundJob`;
- `src/signals/oob.ts` — prompt composition + `publishSessionPrompt` with explicit barrier;
- CLI `signals tick [--execute]`;
- tests: `tick.test.ts`, `escalation.test.ts`, `page.test.ts`.

Done when a low-disk signal with no operator turn produces exactly one deterministic line and one OOB prompt within one tick interval, while a recovered disk produces none.

### Phase 4: watcher and enablement

Files:

- `src/signals/watch/disk.ts` — built-in watcher;
- `src/signals/runner.ts` — daemon leader interval (five minutes);
- `src/daemon.ts` — start/stop the runner with the other leader runners;
- `RUNBOOK.md` — verify one tick owner, inspect, disable;
- `CHECKS.md` — acceptance queries.

Done when the daemon runner is wired, `explain` shows the watcher and next escalation, and the operator has approved enabling it.

Enablement is an explicit operator decision. The spike MUST default to disabled (`signals.enabled=false`) until that approval.

## Implementation Status

Phases 1-4 are implemented in the source tree:

- `src/signals/` — types, validation, store, service, probes, scope/subject guards, render, tick, OOB, page, disk watcher, daemon runner, task producer;
- `src/cli/commands/signals.ts` — raise/update/list/show/ack/resolve/mute/unmute/mute-key/unmute-key/tick/explain/budget;
- `src/runtime/delivery-queue.ts` — `transformTurnPrompt` seam;
- `src/runtime/runtime-request-builder.ts` — piggyback wiring;
- `src/tasks/checkpoint-runner.ts` + `src/signals/producers/task.ts` — stall vs orphan classification and delivery-time ceiling;
- `src/permissions/runtime-bootstrap-provider.ts` — agents get read/raise/ack only; facts, tick, resolve, mute, and update stay operator/daemon authority;
- `src/daemon.ts` — leader-owned `SignalsRunner` every five minutes;
- tests: `src/signals/*.test.ts` plus `src/runtime/delivery-queue.test.ts` and `src/tasks/checkpoint-runner.test.ts`.

Defaults remain safe: `signals.enabled=false`, no cron installed, no daemon restart performed. The daemon must be restarted to load the new runner and CLI command group; enabling the feature is a separate operator decision.

## Test Cases

1. `raise` without `clear_when` -> exit 2, zero rows.
2. `raise` a judgment with `page` -> exit 2, zero rows.
3. Watcher sees 9.2% -> one row, `state=open`, `severity=page`.
4. Watcher ticks again at 9.1% -> same id, one row, `last_seen_at` moves.
5. Next turn at 9.2% -> block contains one item; `surface_count=1`; no extra turn.
6. Next turn at 20.5% -> block omitted; state `resolved`; `close_reason=probe`.
7. Probe throws -> state stays open; render says `unknown`; no page.
8. Tick dry-run at 9.2% -> no outbound, no prompt, no surface row.
9. Tick execute at 9.2% -> one deterministic line, one prompt with `immediate_interrupt`, one surface row.
10. Disk recovers at 20.5% before tick -> zero OOB.
11. Ack at 03:20 -> no repeat before 04:20; still open; repeat after `renotify_after_ms`.
12. Resolve at 03:20 -> no further surfaces.
13. Mute for 12h -> no block, no page.
14. Budget exhausted -> zero items, held line present, `page` still delivered and audited.
15. Two concurrent ticks -> one OOB.
16. Signal scoped `fleet` -> not rendered into a non-fleet agent session.
17. Restart the daemon between raise and turn -> signal still open and surfaces once.
18. `explain` lists scope resolution, last probe value, next surface time, budget, escalation count.
19. Task `in_progress` + `turn_active=false` + `pending_count=0` -> one `task.orphaned` fact, `piggyback`, no OOB.
20. Task `in_progress` + `turn_active=true` + no progress -> `task.stalled` judgment, `piggyback`.
21. Observer row stored with `severity=interrupt` -> render and tick clamp to `piggyback`, no interrupt, `ceiling_clamped` recorded.
22. Orphan task closes -> signal resolves and never surfaces again.
23. Archived task (`archived_at != null`, `status=in_progress`) -> zero new signals; any existing task signal resolves with `subject_terminal`.
24. Signal raised, then task archived, then tick -> no block, no page, state resolved.
25. Ended ephemeral session task -> zero new signals.
26. Re-raise over an archived or terminal subject -> `ENTITY_TERMINAL`, no new row.
27. Unarchive after resolution -> no automatic reopen; a new raise is required.

## Acceptance Criteria

- The full loop works with the disk probe faked in tests, with no real disk pressure.
- A low-disk condition with a pending operator turn costs zero extra turns.
- A low-disk condition with no operator turn reaches the operator deterministically within 10 minutes.
- A recovered disk closes the signal and never pages.
- No duplicate block item and no duplicate page across retries, restarts, or concurrent ticks.
- Disabling signals stops all blocks and all escalations immediately.
- `ravi signals explain host.disk.free` answers why it did or did not surface.
- The v5-probe incident cannot recur: an observer judgment cannot interrupt, and an inactive turn produces an orphan fact instead of a stall.

## Validation

- `bun test src/signals/`
- `bun test src/runtime/delivery-queue.test.ts -t "signal"`
- `bun test src/cli/commands/signals.test.ts`
- `env -u RAVI_CONTEXT_KEY -u RAVI_GATEWAY_URL bun src/cli/index.ts specs get runtime/signals/spike --mode full --json`

## Open Decisions For The Operator

These are product decisions, not implementation details, and MUST be settled before Phase 4:

1. **Enablement owner**: is the fleet session the operator main session, or a dedicated `signals` session? Default proposed: main.
2. **Page channel**: deterministic line goes to the main session's bound chat. Confirm that is the operator's preferred surface for P0.
3. **Budget**: 3 surfaces/day is the proposed hard cap. Confirm or lower it.
4. **Ack ownership**: explicit ack only, or should any operator reply in the target chat ack piggyback judgments? Default proposed: explicit only.
5. **Tick owner**: daemon leader interval (implemented) vs cron shell (alternative). The daemon runner is the default because it shares the live runtime and state DB; a shell job must only be used after the daemon runner is disabled.
6. **Judgment decay**: 72h default. Confirm.
7. **Enablement**: the feature and the disk watcher are off by default (`signals.enabled=false`). Turning them on is an explicit operator decision.

## Known Failure Modes

- The watcher is placed in the render path and starts opening signals during normal turns, coupling attention to conversation volume.
- The deterministic line is sent twice because the page row is written after publishing instead of before.
- The probe cache hides a recovery for 60s and the operator receives a page after the disk is already healthy.
- The disk path probed is not the volume that actually fills (for example, `/` instead of the state volume), so the signal is blind to the real failure.
- `free_pct` uses `bfree` instead of `bavail`, counting blocks reserved for root and overstating available space.
- A signal is resurrected over an archived task because the producer checks only `status`, and `archived_at` never changes status.
- An ended ephemeral session is mistaken for a stalled workload and pages the operator.
- The terminal-subject guard runs only at raise, so an already-open signal keeps surfacing after the task is archived.
- Tick runs under a different user or environment and cannot resolve the fleet session.
- The signal is enabled without a way to disable it quickly; the runbook must include the exact kill switch.
