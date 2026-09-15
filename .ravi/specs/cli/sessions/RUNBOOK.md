# Sessions agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/sessions --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `SESSION_NOT_FOUND`: there are no suggestions by design. Run
   `ravi sessions list --json` (optionally `--agent <id>`) and check the
   session name/key. Remember scope isolation reports unauthorized sessions as
   not-found.
4. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
5. Exit `3`: read `error.plan`, confirm the target session/message, then re-run
   with `--execute`. An `edit-message` plan intentionally reports only provider
   ID presence and new-text length, never either integral value.
6. If `reset`/`delete`/`delete-message`/`edit-message` executed without
   `--execute`, the brake regressed — check the op still calls
   `contractDryRun` before any state/queue/provider call.
7. If an agent keeps hitting exit 3 in a loop, check the hint surfaces
   (`sessions actions --json` promptHints, ephemeral TTL warning,
   prompt-builder) still teach `--execute`.
8. For runtime control, require `--execute` on `follow-up`, `rollback` and
   `fork`; do not add a confirmation loop to `interrupt` or `steer`.

## Validation

```bash
bun test src/cli/commands/sessions.test.ts src/cli/commands/sessions-runtime.test.ts src/prompt-builder.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi sessions info ghost --json                 # expect exit 1, no suggestions
ravi sessions list --no-such-flag --json        # expect exit 2 + acceptedFlags
ravi sessions delete <name> --json              # expect exit 3 + dryRun plan
ravi sessions runtime follow-up <name> "next" --json # expect exit 3, nothing queued
ravi sessions runtime rollback <name> 1 --json  # expect exit 3, history unchanged
ravi sessions runtime fork <name> --json        # expect exit 3, no branch created
ravi sessions list --fields name,agentId --json # expect compact items
```
