---
id: runtime/signals/runbook
title: "Signals Runbook"
kind: runbook
domain: runtime
capability: signals
status: active
normative: true
---

# Signals Runbook

## Inspect

```bash
ravi signals list --json
ravi signals list --state open --json
ravi signals show <id|key> --json
ravi signals explain <id|key> --json
ravi signals budget --json
```

`explain` is the first command for any "why did/didn't this appear?" question. It MUST show scope resolution, last probe value and time, clear rule, cooldown, budget, and next escalation.

## Raise a Fact From Code

```bash
ravi signals raise host.disk.free \
  --kind fact --scope install --severity page \
  --title "Disk free below 15%" \
  --evidence '{"metric":"free_pct","value":9.2,"threshold":15}' \
  --clear-probe host.disk --clear-expr "free_pct >= 20" \
  --recheck 5m --grace 10m \
  --cooldown 6h --ttl 24h --escalate-after 0 \
  --source doctor.disk --json
```

Use `--clear-producer-resolve --ttl <duration>` when the producer cannot expose a probe but promises to call `resolve`.

## Raise a Judgment From an Agent

```bash
ravi signals raise task.stalled.task-123 \
  --kind judgment --scope agent:main --severity piggyback \
  --title "Task task-123 stalled 4h" \
  --evidence '{"task":"task-123","last_progress_at":"..."}' \
  --clear-decay 72h \
  --source session:main-t-1792600099406879 --json
```

Judgments cannot use `nudge`, `interrupt`, or `page`. The CLI rejects them.

## Ack, Resolve, Mute

```bash
ravi signals ack <id> --note "looked at it, deferring until after lunch"
ravi signals resolve <id> --reason "disk cleaned, probe at 38%" --by operator:luis
ravi signals mute <id> --for 12h --reason "known noise during backup"
ravi signals mute --key host.disk.free --for 6h --reason "maintenance window"
ravi signals unmute <id>
```

- `ack` stops repeats for `renotify_after_ms`; it does not close a fact.
- `resolve` needs a reason and is terminal.
- `mute` suppresses both routes until `muted_until`.

## Tick

```bash
ravi signals tick --json            # dry run, no sends
ravi signals tick --execute --json  # evaluate, escalate, page
```

Install exactly one scheduler owner. Proposed for the spike:

```bash
ravi cron add signals-tick --every 5m --shell "ravi signals tick --execute"
```

Verify with `ravi cron show <id>` that the agent/account/session are what you expect. Do not also enable a daemon interval.

If tick is down: piggyback still works, escalation does not. `explain` reports `next_escalation` and the last tick time.

## Kill Switch

```bash
ravi settings set signals.enabled false
```

Verify:

```bash
ravi signals explain <id> --json   # shows enabled=false
```

Then confirm no block appears in the next turn. Re-enable with `signals.enabled=true`.

## Probe Failure

Symptoms:

- `explain` shows `last_eval_error`;
- the block says `unknown`;
- state remains open.

Do not resolve the signal to silence it. Fix the probe or mute the key with a reason. If a probe fails three ticks in a row, a later phase raises `signals.probe.failing`.

## Suspected Duplicate Delivery

1. `ravi signals show <id> --json` and inspect `signal_surfaces`.
2. Confirm one row per logical escalation (deterministic line and OOB prompt share one row).
3. Check for two tick owners (`ravi cron list`, daemon interval).
4. Check whether the producer changed the key between raises.

## Too Many Signals

1. `ravi signals budget --json` to see daily usage.
2. `ravi signals list --state open --json` and sort by producer.
3. Mute noisy keys, not individual signals, when the producer is the problem.
4. Lower `max_surfaces` or raise `cooldown_ms` for that producer.
5. If a judgment is being raised every turn, fix the agent instruction, not the budget.

## Restart / Recovery

Signals are local and durable. After a daemon restart:

- open, acknowledged, and muted state is preserved;
- no signal is re-delivered just because of the restart;
- the next turn evaluates the clear rule again;
- the next tick recomputes escalation.

If a signal is stuck in `surfaced` with no `surfaced_at`, treat it as corrupt, inspect `signal_events`, and resolve with `reason=operator` after confirming the condition.

## Database Checks

Use the state DB from `getRaviStateDir()` (see `src/utils/paths.ts`).

```sql
SELECT state, count(*) FROM signals GROUP BY state;
SELECT id, key, state, surface_count, escalation_count FROM signals WHERE state NOT IN ('resolved','expired');
SELECT signal_id, route, created_at FROM signal_surfaces ORDER BY created_at DESC LIMIT 20;
SELECT count(*) FROM signals WHERE state NOT IN ('resolved','expired') AND clear_when_json IS NULL;
```

The last query MUST return 0.
