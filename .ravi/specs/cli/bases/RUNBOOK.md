# Bases agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/bases --mode rules --json`.
2. Reproduce with `--json` and `--project <ref>`; check `error.code`,
   `error.consoleError`, and `error.requestId`.
3. `PROJECT_ACCESS_DENIED` with `missingScopes`: run `ravi login` again.
   Without `missingScopes`: the user lacks project or base access; try the
   view the user was given (`--view`).
4. `VERSION_CONFLICT`: read `error.current`, merge, retry with
   `--expected-version <current.version>`.
5. `CONFLICT` with `consoleError: idempotency_conflict`: the key was reused
   with another body. For imports, re-run with the original `--batch`.
6. `PAYLOAD_INVALID` with `cursor_invalid`: re-run without `--cursor`.
7. A brake that reached the Console, or a 409 reported as `AUTH_PENDING` on a
   Bases path, is a regression: check `contractDryRun` ordering in
   `src/cli/commands/bases.ts` and `statusToErrorCode` in
   `src/cloud-auth/client.ts`.
8. Row events missing: `ravi bases subscriptions <base> --json`, then
   `ravi inbox status`; events arrive on `ravi.console.inbox.item` with
   `category: "bases"`.

## Validation

```bash
bun test src/bases/ src/cloud-auth/
bun test --timeout 20000 src/cli/commands/bases.test.ts
bun test src/cli/confirmation-policy.test.ts src/cli/commands/json-coverage.test.ts \
  src/cli/commands/pagination-coverage.test.ts src/sdk/client-codegen/return-schema-coverage.test.ts
make quality
```

Live checks (requires `ravi login` with the Bases scopes):

```bash
ravi bases list --project <ref> --json
ravi bases rows query <base> --limit 5 --json
ravi bases rows purge <base> <row> --json   # expect exit 3, nothing deleted
```
