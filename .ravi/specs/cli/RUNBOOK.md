# Global CLI Contract / RUNBOOK

## Diagnose a contract regression

1. Reproduce through the real surface that failed. Record command/body,
   runtime-context presence, stdout, stderr, status and side-effect evidence.
2. Identify the stage: authorization, input parsing, entity resolution,
   confirmation, handler, transport adapter or audit.
3. Reproduce the same semantic invocation through process CLI, exported tool
   and gateway when the command is public on those surfaces.
4. If an envelope is followed by `Error:`, inspect generic catches. A
   `ContractError` must remain structured and be rendered once.
5. If a gateway returns 500, verify the dispatcher translates
   `ContractError` before its generic error path.
6. If an operation is denied/allowed unexpectedly, inspect the implementation
   effect before changing `CommandAccess.kind`; then scan live capability
   consumers and templates.
7. If exit `3` appears, verify the effect against the policy table. Confirm
   that validation/not-found ran first and use spies to prove the plan caused
   no side effect.
8. If a smoke breaks after adding a brake, update the consumer only when the
   classification is correct. Otherwise remove the brake; do not teach callers
   to confirm low-risk routine work.
9. Compare local and CI failures by test name and platform. A changed shared
   dependency can regress an unchanged test file.

## Pre-merge sequence

```bash
bun test src/cli/commands/usage-exit.smoke.test.ts
bun test src/cli/tools-export.test.ts src/sdk/gateway/dispatcher.test.ts
bun test src/cli/command-access.test.ts src/cli/registry.test.ts
bun test src/cli/schema-inference.test.ts src/sdk/client-codegen/codegen.test.ts
bun run typecheck
$env:GITHUB_BASE_REF="dev"
bun src/ci/run-quality-gate.ts
```

Review the diff after the gates:

- root spec contains global rules; domain specs contain only local facts;
- product specs changed only when behavior or an executable example changed;
- skill growth is justified by domain doctrine, not copied `--help` output;
- ledger claims match current tests and CI evidence;
- each coherent correction has its own commit.
