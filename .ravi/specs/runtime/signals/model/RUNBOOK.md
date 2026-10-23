---
id: runtime/signals/model/runbook
title: "Signals Model Runbook"
kind: runbook
domain: runtime
capability: signals
feature: model
status: active
normative: true
---

# Signals Model Runbook

## Inspect a Record

```bash
ravi signals show <id|key> --json
ravi signals explain <id|key> --json
```

Check:

- `state` and `previous_state`;
- `clear_when_json`;
- `last_eval_at`, `last_eval_error`;
- `surface_count`, `escalation_count`;
- `closed_at`, `close_reason`.

## Force Closure

```bash
ravi signals resolve <id|key> --reason "verified by operator at 14:20" --by operator:<id>
```

Use only when the clear rule cannot run or the condition is being retired by decision. A fact resolved by a person is not evidence that the fact is false; the reason must say what was verified.

## Reopen After Ignored Expiry

Ignored signals expire with `reason=ignored`. They cannot reopen before `reopen_after_ms`. If the condition is urgent before then, raise a new key (for example, `host.disk.free.critical`) with explicit operator approval, or resolve the expired record and let the producer re-raise.

## Probe Debug

1. `explain` shows the probe id and last fields.
2. Run the probe unit test: `bun test src/signals/probes.test.ts -t "<probe>"`.
3. If the probe uses a cache, wait for `recheck_ms` or clear the cache in a debug session.
4. Never lower the threshold to make a test pass.

## Scope Debug

If `explain` says `out_of_scope`:

- confirm the session's agent id, bound chat, contact, and project;
- confirm `signals.fleet_session` when the scope is `fleet`;
- confirm the signal's `target_sessions` override.

A signal without a resolvable session is list-only by design, not a delivery bug.

## Migration

There is no migration from another notifier in v1. Old cron/heartbeat checks remain until their producer is moved to `signals raise`. Do not run both for the same condition: that doubles surfaces and budgets.
