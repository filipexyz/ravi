# MCP Bridges agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/bridges --mode rules --json`.
2. Reproduce with `--json`; verify the stable CloudAuthError code is preserved
   under the global exit map.
3. `WRITE_REQUIRES_EXECUTE` (exit 3): read `error.plan`, confirm the bridge id,
   re-run with `--execute` (or `--yes`, the legacy equivalent).
4. `PAYLOAD_INVALID` "Missing --project": pass `--project <ref>` or set
   `RAVI_PROJECT`; find refs with `ravi cloud projects list --json`.
5. `AUTH_REQUIRED`/`AUTH_EXPIRED`: run `ravi login` and retry.
6. If `revoke` executed without `--yes`/`--execute`, the brake regressed —
   check `contractDryRun` ordering in `src/cli/commands/bridges.ts`.
7. If a brake exits 5 as `SERVER_UNAVAILABLE`, the ContractError rethrow guard
   in `runBridgesCommand` was lost.

## Validation

```bash
bun test src/cli/commands/bridges.test.ts
```

Live checks against the local CLI (requires `ravi login` + a project):

```bash
ravi bridges list --project <ref> --json                 # expect bridges + pagination
ravi bridges list --project <ref> --fields id,status --json  # expect compact items
ravi bridges revoke bridge_x --json                      # expect exit 3 + plan, nothing revoked
```
