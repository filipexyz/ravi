# Threads agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/threads --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `THREAD_NOT_FOUND`: read `error.suggestions` — live thread
   ids/slugs/titles similar to what was asked. Retry with one of them.
4. Exit `1` without a code (plain text): either an ambiguous slug across
   scopes (disambiguate with `--scope type:id`) or an invalid pointer
   (`type:id` syntax).
5. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that
   op (requires the domain to be registered in `AGENT_CONTRACT_DOMAINS`).
6. There is NO exit 3 in this domain — if a threads op ever returns 3,
   someone added a brake without updating this spec.

## Validation

```bash
bun test src/cli/commands/threads.test.ts
```

Live checks against the local CLI (read-only; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi threads show thr-nope --json          # expect exit 1 + THREAD_NOT_FOUND + suggestions
ravi threads list --fields id,status --json # expect compact items
ravi threads list --json                    # expect full items + pagination
```
