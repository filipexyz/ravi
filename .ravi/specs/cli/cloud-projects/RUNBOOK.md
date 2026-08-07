# Cloud Projects agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/cloud-projects --mode rules --json`.
2. Reproduce with `--json`; `PAYLOAD_INVALID` exits `2` and
   `WRITE_REQUIRES_EXECUTE` is the only exit-3 code.
3. `WRITE_REQUIRES_EXECUTE`: read `error.plan`; FIRST confirm the organization
   with `ravi whoami --json` (wrong-org creates are the incident pattern —
   see `cli/console-scope`), then re-run with `--execute`.
4. `PAYLOAD_INVALID` on visibility: use one of `public`, `private`,
   `protected_link`.
5. `AUTH_REQUIRED`/`AUTH_EXPIRED`: run `ravi login` and retry.
6. If `create` hit Console without `--execute`, the brake regressed — check
   `contractDryRun` ordering in `src/cli/commands/cloud-projects.ts`.
7. If a brake exits 5 as `SERVER_UNAVAILABLE`, the ContractError rethrow guard
   in `runCloudProjectsCommand` was lost.

## Validation

```bash
bun test src/cli/commands/cloud-projects.test.ts
```

Live checks against the local CLI (requires `ravi login`; create stays
dry-run):

```bash
ravi whoami --json                                   # confirm the org FIRST
ravi cloud projects list --json                      # remote projects + pagination
ravi cloud projects list --fields slug,id --json     # expect compact items
ravi cloud projects create demo-slug --json          # expect exit 3 + plan, nothing created
```
