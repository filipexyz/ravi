---
id: runtime/signals/producers/checks
title: "Signals Producers Checks"
kind: checks
domain: runtime
capability: signals
feature: producers
status: active
normative: true
---

# Signals Producers Checks

```bash
bun test src/signals/producers.test.ts
bun test src/signals/ceilings.test.ts
bun test src/cli/commands/signals.test.ts
```

## Required Cases

- fact probe raise -> row with `kind=fact`, probe rule;
- fact producer_resolve raise -> row with TTL;
- judgment raise with decay -> row with `kind=judgment`;
- judgment with `nudge|interrupt|page` -> exit 2, no row;
- unregistered probe -> exit 2, no row;
- unknown scope -> exit 2, no row;
- missing title -> exit 2, no row;
- missing clear rule -> exit 2, no row;
- re-raise same key -> update, one row;
- `resolve` without reason -> exit 2;
- `raise --json` returns created vs updated and the effective rule.

## Catalog Consistency

- Every key in the fact catalog has a registered probe or a named push producer.
- Every judgment key has an owning agent or surface documented in `applies_to`.
- No fact key includes an incident id or timestamp.
- No judgment declares `escalate_after_ms`.
- A task observer judgment is stored at `piggyback` or lower.
- A task observer cannot reach `interrupt` or `page` even if the stored row says so.
- `task.orphaned` exists as a fact and resolves on task terminal state.
- `task.stalled` evidence includes `turn_active=true`.
- `task.orphaned` evidence includes `turn_active=false` and `pending_count=0`.
- A task with `archived_at != null` produces no new signal.
- A task from an ended ephemeral session produces no new signal.
- Re-raising over an archived or terminal subject is rejected with `ENTITY_TERMINAL`.
- An existing open signal whose subject becomes archived resolves with `close_reason=subject_terminal`.

## CLI

```bash
ravi signals raise <key> ... --json
ravi signals list --json
ravi signals show <id> --json
ravi signals ack <id> --json
ravi signals resolve <id> --reason "..." --json
ravi signals mute <id> --for 1h --reason "..." --json
```

Each must be idempotent where declared and must leave zero partial rows on validation failure.
