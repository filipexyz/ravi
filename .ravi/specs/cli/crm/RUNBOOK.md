# CRM agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/crm --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` before
   anything else; the code, not the message, is the branch point.
3. Check the exit code against the taxonomy: `1` the entity or provider failed,
   `2` the call itself was malformed, `3` a global policy brake stopped it.
4. On exit 1, read `error.suggestions` — the op already looked for similar
   entities, so a retry with a suggestion is usually the fix.
5. On exit 2, read `error.acceptedFlags`; the flag set is authoritative for that
   op and is cheaper than re-reading help.
6. `pipeline create`, `opportunity create`, and `opportunity move` are immediate
   local mutations. If any returns exit 3, an obsolete domain brake was
   reintroduced; verify the command no longer declares `--execute`.

## Validation

```bash
bun test src/cli/commands/crm.test.ts src/apps/router.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR` to avoid touching real state):

```bash
ravi crm pipeline show unknown-id --json          # expect exit 1 + suggestions
ravi crm board --no-such-flag --json              # expect exit 2 + acceptedFlags
ravi crm pipeline create "X" --json               # expect exit 0 + created pipeline
ravi crm pipeline list --fields id,name --json    # expect compact items
```
