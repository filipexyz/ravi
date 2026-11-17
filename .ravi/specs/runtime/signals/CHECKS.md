---
id: runtime/signals/checks
title: "Signals Checks"
kind: checks
domain: runtime
capability: signals
status: active
normative: true
---

# Signals Checks

## Spec and Schema

```bash
env -u RAVI_CONTEXT_KEY -u RAVI_GATEWAY_URL bun src/cli/index.ts specs get runtime/signals --mode full --json
```

- Every non-terminal signal has a non-null `clear_when_json`.
- Every signal has exactly one scope.
- No judgment has `severity` above `piggyback`.
- `key` is unique among non-terminal rows.

```sql
SELECT count(*) FROM signals
WHERE state NOT IN ('resolved','expired') AND clear_when_json IS NULL;

SELECT kind, severity, count(*) FROM signals
WHERE state NOT IN ('resolved','expired')
GROUP BY kind, severity;

SELECT key, count(*) FROM signals
WHERE state NOT IN ('resolved','expired')
GROUP BY key HAVING count(*) > 1;
```

The first and third queries MUST return 0 rows. The second MUST show no `judgment` row with `nudge`, `interrupt`, or `page`.

## Lifecycle

- Raise without a clear rule exits 2 and writes nothing.
- Judgment with `page` exits 2 and writes nothing.
- Raise twice with the same key returns one non-terminal row and increments `version`.
- Clear rule true resolves; TTL expires; `max_surfaces` expires with `reason=ignored`.
- Ack is idempotent and does not resolve a fact.
- Mute suppresses surfaces and escalations.
- A muted signal that clears becomes `resolved`.

## Delivery

- Piggyback creates zero turns.
- The prompt block is absent when no signal is eligible.
- The block has at most 3 items and 1200 characters.
- The surface ledger has one row per surface.
- Cooldown is shared across piggyback and OOB.
- Budget is counted from `signal_surfaces`, not memory, and survives restart.
- `page` emits one deterministic line and one OOB prompt, sharing one surface row.
- `nudge` uses `after_response`; `interrupt` and `page` use `immediate_interrupt`.
- A judgment never produces OOB.
- Tick dry-run publishes nothing.
- Two concurrent ticks produce one OOB batch.

## Scope

- `install` resolves to one existing canonical session, or no target when unbound; never a bare agent id.
- A `person` signal with no bound session stays list-only.
- A project goal that is no longer active stops granting scope visibility, prompt rendering and pending OOB delivery to its session.
- A signal is never rendered into a session outside its scope.
- `--all` requires operator capability.

## Failure

- Probe error keeps the signal open and renders `unknown`.
- A probe timeout does not block the turn beyond its bound.
- Signals store unavailable: turn proceeds without a block and logs a warning.
- Persist-surface failure omits the block rather than risking a double delivery.

## Commands

```bash
bun test src/signals/
bun test src/runtime/delivery-queue.test.ts -t "signal"
bun test src/cli/commands/signals.test.ts
ravi signals tick --json
ravi signals explain <id> --json
```

## Regression Fixtures

- One fact with `page` and `escalate_after_ms=0`.
- One fact with `piggyback` and no escalation.
- One judgment with decay.
- One muted signal.
- One acknowledged signal inside renotify.
- One cleared signal.
- One probe-error signal.
- One signal at the daily budget boundary.

The fixture set MUST be reused by render, tick, and CLI tests so the three paths cannot drift.

## PR 751 review regressions

- `src/signals/review-regressions.test.ts`: retarget, downgrade, mute during page send, concurrent tick/drain ownership, failed-probe freshness, caller-session targeting, canonical install target, atomic observation invalidation and migration from existing observation columns.
- `src/cli/commands/signals.test.ts`: key mute/unmute use the same caller visibility predicate.
- `src/runtime/turn-origin.test.ts` and `src/runtime/runtime-request-context.test.ts`: typed signal origin resolves on a destination chat; unknown external actors remain denied.
