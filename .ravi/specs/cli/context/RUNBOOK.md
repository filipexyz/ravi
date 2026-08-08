# Context agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/context --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `CONTEXT_NOT_FOUND`: read `error.suggestions` — live context IDs
   similar to what was asked. Retry with one of them, or widen with
   `ravi context list --all --json`.
4. Exit `1` + `CREDENTIAL_NOT_FOUND`: suggestions are context IDs and labels
   (never keys). Match them against `ravi context credentials list --json` to
   find the right stored key.
5. Exit `3`: read `error.plan`, confirm the revoke/removal is intended, then
   re-run the same command adding `--execute`. For `context prune`, the
   equivalent is `--apply --confirm prune-contexts`; for
   `cleanup-agent-runtime`, it is `--revoke`.
6. If a revoke or entry removal executed without `--execute`, the brake
   regressed: check the op still calls `contractDryRun` before the write.
7. If a full `rctx_*` key shows up inside an error envelope, dry-run plan or
   suggestion list, that is a security regression against invariant 6 of the
   SPEC — fix before anything else ships.

## Validation

```bash
bun test src/cli/commands/context.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi context info ctx-nope --json                    # expect exit 1 + suggestions
ravi context revoke <context-id> --json              # expect exit 3 + dryRun plan (IDs/flags)
ravi context revoke <context-id> --json --execute    # expect real revoke
ravi context credentials remove <key> --json         # expect exit 3 + key/path/label presence only
ravi context list --fields contextId,kind --json     # expect compact items
ravi context prune --json                            # expect planned counts (no delete)
```
