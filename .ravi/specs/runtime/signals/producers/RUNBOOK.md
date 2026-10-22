---
id: runtime/signals/producers/runbook
title: "Signals Producers Runbook"
kind: runbook
domain: runtime
capability: signals
feature: producers
status: active
normative: true
---

# Signals Producers Runbook

## Add a Fact Key

1. Decide whether a probe can prove it. If yes, add the probe first (`src/signals/probes.ts`) with fields, timeout, and tests.
2. Add the key to the fact catalog in `SPEC.md`.
3. Implement the producer:
   - probe: raise once with `--clear-probe`; the evaluator closes it;
   - push: raise on transition and resolve on recovery, or use `--clear-producer-resolve --ttl`.
4. Choose ceiling by consequence, not by drama:
   - `page`: operator must know even if nobody is talking (disk, daemon crash loop, channel offline);
   - `interrupt`: important but can wait for a safe barrier (credential expiring, stuck turn);
   - `nudge`: worth one follow-up turn (cost spike, rate limit);
   - `piggyback`: context only.
5. Test both routes with a fake probe.

## Add a Judgment Key

1. Confirm the condition is not already a task, CRM fact, or inbox item.
2. Define the key template with a stable id (`<condition>.<entity-id>`).
3. Define evidence fields the agent must read.
4. Define decay (default 72h) and cooldown (default 12h).
5. Update the agent instruction that owns the condition; otherwise the judgment will never be raised.

## Producer Hygiene

- One key per condition, not per occurrence.
- Resolve push facts when they recover. If you cannot, use a probe or TTL.
- Refresh evidence on every raise; stale evidence is worse than no signal.
- Do not put secrets, tokens, raw customer data, or full paths in `detail`.
- Do not raise "all good" signals. Absence of a signal is the healthy state.

## Audit a Producer

```bash
ravi signals list --json
ravi signals explain <id> --json
```

Look for:

- many terminal rows for the same key in a short window (flapping or bad key);
- open facts with `last_seen_at` older than TTL/2 (producer died);
- judgments that never ack and never decay (agent ignores its own signals);
- judgments raised every turn (agent instruction defect).

## Triage a Task Observer Alert

1. Read the task and the session:

```bash
ravi tasks show <task-id> --json
ravi sessions info <session> --json
```

2. Ask the runtime-state question before the progress question:

- `archived_at != null` -> terminal for signal purposes; the signal must resolve with `subject_terminal`, and no new signal may be raised. Archiving does not change `status`.
- ephemeral session ended and task not re-dispatched -> terminal for signal purposes; no stall, no orphan.
- `turn_active=true` and no progress -> `task.stalled` judgment (max `piggyback`).
- `pending_count>0` -> wait; the queued turn may still make progress.
- `turn_active=false` and `pending_count=0` -> `task.orphaned` fact (low severity, closes when the task closes).
- terminal task -> resolve any open task signal.

3. If an observer delivered `interrupt` or `page` for a task judgment, treat it as a delivery defect: check the stored severity, the producer class, and the `ceiling_clamped` event. The observer must not interrupt.
4. Resolve the false positive with `--reason`, then fix the producer check instead of muting the key. Muting hides the next real stall.

## Moving a Heartbeat Check

1. Identify the condition the heartbeat checks.
2. If it is measurable, implement a probe and raise a fact.
3. If it requires reading context, keep the agent but raise a judgment instead of messaging.
4. Remove the heartbeat check only after the signal has run in shadow mode for a day.
5. Never run both: double surfaces and double cost.
