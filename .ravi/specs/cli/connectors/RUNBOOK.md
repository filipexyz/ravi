# Connectors agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/connectors --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first — on this domain the
   exit code alone is ambiguous (legacy CloudAuthError map coexists).
3. `WRITE_REQUIRES_EXECUTE` (exit 3): read `error.plan`, confirm the revoke is
   intended, re-run with `--execute` (or `--yes`, the legacy equivalent).
4. `AUTH_REQUIRED`/`AUTH_EXPIRED` (exit 2): run `ravi login` and retry.
5. `PAYLOAD_INVALID` mentioning projects: connectors are project-scoped — pass
   `--project <id-or-slug>` from `ravi cloud projects list --json`.
6. If `revoke` executed without `--yes`/`--execute`, the brake regressed:
   check the `contractDryRun` call ordering in
   `src/cli/commands/connectors.ts`.
7. If a brake exits 5 as `SERVER_UNAVAILABLE`, the ContractError rethrow guard
   in `runConnectorCommand` was lost.

## Validation

```bash
bun test src/cli/commands/connectors.test.ts
```

Live checks against the local CLI (requires `ravi login`; revoke checks are
dry-run only unless you really mean it):

```bash
ravi connectors list --json                          # expect connections + pagination
ravi connectors list --fields id,provider --json     # expect compact items
ravi connectors revoke conn_x --json                 # expect exit 3 + plan, nothing revoked
```
