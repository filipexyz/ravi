# Artifacts agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/artifacts --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `ARTIFACT_NOT_FOUND`: read `error.suggestions` — real ledger ids
   and titles similar to what was asked. Retry with one of them, or list with
   `ravi artifacts list --json`.
4. Exit `1` + `ARTIFACT_VERSION_NOT_FOUND`: list the real versions with
   `ravi artifacts versions <id> --json` and retry with an existing number.
5. Exit `3`: read `error.plan`, confirm the upload/exposure is intended, then
   re-run the same command adding `--execute`.
6. If a publish/activation executed without `--execute`, the brake regressed:
   check the op still calls `contractDryRun` BEFORE the try block that talks to
   Console.
7. If a braked op in agent context reports `SERVER_UNAVAILABLE` with exit 5,
   the CloudAuthError funnel swallowed the ContractError — the catch must
   rethrow `ContractError` first (model: mail.ts).
8. Auth failures on publish/activate (`AUTH_REQUIRED`/`AUTH_EXPIRED`) are NOT
   part of this contract: they keep the legacy funnel — run `ravi login`.

## Validation

```bash
bun test src/cli/commands/artifacts.test.ts
bun test src/sdk/gateway/artifacts-show.integration.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi artifacts show art-nope --json                       # expect exit 1 + suggestions
ravi artifacts version <id> --version 999 --json          # expect exit 1 + ARTIFACT_VERSION_NOT_FOUND
ravi artifacts publish ./site --project p --site s --json # expect exit 3 + dryRun plan, no upload
ravi artifacts release activate <id> --release r --json   # expect exit 3 + dryRun plan
ravi artifacts list --fields id,kind --json               # expect compact items
```
