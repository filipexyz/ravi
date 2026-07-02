---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage - Runbook"
kind: runbook
domain: sdk
capability: schema
feature: returns-coverage
owners:
  - dev
status: draft
---

# Runbook

## Diagnosing a `newlyWeak` regression

When `ravi sdk returns validate --json` fails with `NEW_WEAK_PUBLIC_RETURN_SCHEMA`
or `bun test src/sdk/client-codegen/return-schema-coverage.test.ts` fails on the
weak-baseline check, follow these steps.

### 1. Identify the newly weak commands

```bash
ravi sdk returns status --json
```

Look at the `newlyWeak` array. Each entry is a public command whose return
schema the quality analyzer considers weak.

### 2. Inspect the quality report for each command

```bash
bun -e "
import 'reflect-metadata';
import { getRegistry } from './src/cli/registry-snapshot.ts';
import { analyzeCommandReturnSchema } from './src/sdk/client-codegen/return-schema-quality.ts';
const reg = getRegistry();
const cmd = reg.commands.find(c => c.fullName === '<command-name>');
console.log(JSON.stringify(analyzeCommandReturnSchema(cmd), null, 2));
"
```

The `issues` array tells you the exact weakness (e.g. `UNKNOWN_SCHEMA`,
`OPEN_OBJECT`, `EMPTY_OBJECT`, `UNKNOWN_ADDITIONAL_PROPERTIES`).

### 3. Fix the return schema

1. Open the command file (e.g. `src/cli/commands/<group>.ts`).
2. Find the `declareCommandReturns` call or `@Returns(...)` decorator.
3. Replace the weak schema (`commandEnvelopeReturnSchema`, `looseObjectSchema`,
   etc.) with a concrete Zod schema that matches the actual return payload.
4. Add the schema to `src/cli/commands/operational-return-schemas.ts`.
5. Use `.strict()` on objects to prevent passthrough.
6. Avoid `z.unknown()`, `z.object({}).passthrough()`, or empty objects.

### 4. Remove from baseline

If the fixed command was in `WEAK_PUBLIC_RETURN_COMMANDS_BASELINE`, remove it.

### 5. Validate

```bash
bun run build
ravi sdk returns status --json          # newlyWeak must be []
ravi sdk returns validate --json        # must pass
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun run typecheck
```

### 6. Update generated artifacts

If schema changes affect codegen output:

```bash
ravi sdk openapi check --json
ravi sdk client check --json
ravi sdk swift check --json
```

## When `strengthenedButStillListed` is non-empty

This means a command was strengthened but is still in the baseline. Remove
the command from `WEAK_PUBLIC_RETURN_COMMANDS_BASELINE` in
`src/sdk/client-codegen/return-schema-quality-baseline.ts`.

## When to use `@CliOnly()`

Only mark a command `@CliOnly()` when it:
- Is interactive or streams output (TUI, watch, live logs)
- Has no stable JSON request/response contract
- Is process-level (daemon start, service run)
- Has no meaningful remote invocation semantics

Document the justification in the PR.
