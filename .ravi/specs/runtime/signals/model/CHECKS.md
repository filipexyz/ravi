---
id: runtime/signals/model/checks
title: "Signals Model Checks"
kind: checks
domain: runtime
capability: signals
feature: model
status: active
normative: true
---

# Signals Model Checks

```bash
bun test src/signals/model.test.ts
bun test src/signals/probes.test.ts
bun test src/signals/signal-db.test.ts
```

## Required Cases

- raise without clear rule -> exit 2, no row;
- judgment above ceiling -> exit 2, no row;
- same key twice -> one non-terminal row, `version` increased;
- terminal + reopen inside window -> `reopen_suppressed`;
- terminal + reopen after window -> new id, same key;
- `probe` predicate true -> `resolved`;
- `probe` with `grace_ms` -> not resolved until grace holds;
- probe error -> open, `last_eval_error` set;
- `max_surfaces` -> `expired`, `reason=ignored`;
- mute -> no surface; unmute -> re-evaluate clear first;
- ack terminal -> no-op;
- `manual` clear on a fact -> rejected;
- unknown probe or field -> exit 2.

## Data Integrity

```sql
SELECT count(*) FROM signals
WHERE state NOT IN ('resolved','expired') AND clear_when_json IS NULL;

SELECT key, count(*) FROM signals
WHERE state NOT IN ('resolved','expired')
GROUP BY key HAVING count(*) > 1;

SELECT count(*) FROM signals
WHERE kind='judgment' AND severity IN ('nudge','interrupt','page');
```

All three MUST return 0.

## Restart

Raise an open signal, a muted signal, and an acknowledged signal; restart the daemon; confirm all three state values are unchanged and no surface was created by the restart.
