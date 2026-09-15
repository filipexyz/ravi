---
id: sessions/goals/runbook
title: "Session Goals — Runbook"
kind: capability
domain: sessions
capability: goals
status: active
normative: false
---

# Session Goals Runbook

The daemon and an initialized runtime session with goal support are required. Codex is the first supported adapter.

```bash
ravi sessions goal set <session> "Implement the requested feature" --json
ravi sessions goal get <session> --json
ravi sessions goal pause <session> --json
ravi sessions goal resume <session> --json
ravi sessions goal block <session> --reason "Waiting for the requested input" --json
ravi sessions goal complete <session> --json
ravi sessions goal clear <session> --json
```

Use `--budget <tokens>` only when a token budget was requested. `set` with a new objective follows the runtime's replacement/accounting semantics. Pause/resume change status without sending the objective again. Completion means the actual work is done.

Setting/resuming an active goal on an idle session queues managed work and uses the session's attached output target. `pause` stops future automatic continuation; an already executing turn can still finish. `get` refreshes the confirmed state without starting model work.

If a command reports unsupported goal control, do not assume a local objective will drive continuation. Add a goal adapter for that provider or use a provider that advertises the capability. If the session has no native id or its provider changed, initialize a normal turn first.

For divergent legacy state, record the desired objective and check the native snapshot with `goal get`. Reapply an active objective only with current user authorization; do not reactivate a goal the user paused.

If work stops, inspect `goal get` and the runtime trace. Distinguish `blocked`, `paused`, `budget_limited`, `usage_limited`, native turn failure and intentional interruption. Review a native block's conversation context when no structured reason was supplied. Refresh usage with `get`; the legacy `account` command is rejected.
