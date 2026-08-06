# Contacts agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/contacts --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `CONTACT_NOT_FOUND`: read `error.suggestions` — contact ids and
   names similar to what was asked, drawn only from the caller's visible scope.
   Retry with one of them, or widen with `ravi contacts list --json`.
4. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
5. Exit `3`: read `error.plan`, confirm the removal/block/merge is intended,
   then re-run the same command adding `--execute` (for `backfill`, the
   equivalent confirm flag is `--apply`).
6. If a remove/block/merge executed without `--execute`, the brake regressed:
   check the op still calls `contractDryRun` before the service call, and that
   the registry dispatcher still maps `ContractError.exitCode`.
7. If a not-found inside `timeline|messages|activity|sessions|profile|note|
   metadata` comes back as plain `Error: ...` text, the command's catch lost
   the `rethrowContactCommandError` mapping — see `src/cli/commands/contacts.ts`.
8. If a suggestion names a contact the caller should not see, the candidates
   stopped going through `filterVisibleContacts` — that is a scope leak, fix
   before anything else.

## Validation

```bash
bun test src/cli/commands/contacts.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi contacts get nope-999 --json                 # expect exit 1 + suggestions
ravi contacts list --no-such-flag --json          # expect exit 2 + acceptedFlags
ravi contacts block <contact-id> --json           # expect exit 3 + dryRun plan
ravi contacts merge <src> <dst> --json            # expect exit 3 + dryRun plan
ravi contacts list --fields id,name --json        # expect compact items
```
