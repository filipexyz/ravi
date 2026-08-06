# CRM agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get crm/agent-first-cli --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` before
   anything else; the code, not the message, is the branch point.
3. Check the exit code against the taxonomy: `1` the entity or provider failed,
   `2` the call itself was malformed, `3` the write brake stopped it.
4. On exit 1, read `error.suggestions` — the op already looked for similar
   entities, so a retry with a suggestion is usually the fix.
5. On exit 2, read `error.acceptedFlags`; the flag set is authoritative for that
   op and is cheaper than re-reading help.
6. On exit 3, read `error.plan` to confirm the write is the one intended, then
   re-run the same command adding `--execute`.
7. If a write executed without `--execute`, the brake regressed: check that the
   op still routes through the contract helper before the provider call.

## Validation

```bash
bun test src/cli/commands/crm.test.ts src/apps/router.test.ts
```

Live checks against a built CLI (all read-only or dry-run):

```bash
ravi crm pipeline show <unknown-id> --json     # expect exit 1 + suggestions
ravi crm opportunity create "X" --value abc --json  # expect exit 2 + acceptedFlags
ravi crm pipeline create "X" --json            # expect exit 3 + dryRun plan
ravi crm pipeline list --fields id,name --json # expect compact items
```
