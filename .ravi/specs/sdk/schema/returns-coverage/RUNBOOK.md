---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage - Runbook"
kind: runbook
domain: sdk
capability: schema
feature: returns-coverage
owners:
  - dev
status: active
---

# Runbook

## Diagnosing a weak return schema regression

When `ravi sdk returns validate --json` fails with `WEAK_PUBLIC_RETURN_SCHEMA`
or `bun test src/sdk/client-codegen/return-schema-coverage.test.ts` fails on the
weak-baseline check, follow these steps.

### 1. Identify the weak commands

```bash
ravi sdk returns status --json
```

Look at the `weakPublic` count. If nonzero, the schema quality analyzer
detected weak return schemas in public commands.

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
`OPEN_OBJECT`, `EMPTY_OBJECT`, `UNKNOWN_ADDITIONAL_PROPERTIES`,
`UNKNOWN_ARRAY_ITEMS`).

### 3. Fix the return schema

1. Open the command file (e.g. `src/cli/commands/<group>.ts`).
2. Find the `declareCommandReturns` call or `@Returns(...)` decorator.
3. Replace the weak schema with a concrete Zod schema matching the actual
   return payload.
4. For dynamic/opaque payloads use `jsonObjectSchema` or `jsonValueSchema`
   instead of `z.unknown()` or `looseObjectSchema`.
5. Remove `.passthrough()` from object schemas (objects default to
   `additionalProperties: false` without it).
6. For arrays of unknown items, use `z.array(jsonValueSchema)`.

### 4. Validate

```bash
bun run build
ravi sdk returns status --json          # weakPublic must be 0
ravi sdk returns validate --json        # must pass
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun run typecheck
```

### 5. Update generated artifacts

If schema changes affect codegen output:

```bash
ravi sdk openapi check --json
ravi sdk client check --json
ravi sdk swift check --json
```

## Valid exceptions for `@CliOnly()`

Only mark a command `@CliOnly()` when it:
- Is interactive or streams output (TUI, watch, live logs)
- Has no stable JSON request/response contract
- Is process-level (daemon start, service run)
- Has no meaningful remote invocation semantics

Document the justification in the PR.

## Adding a new public command

1. Declare `@Returns(zod)` with a concrete schema.
2. Use explicit object fields with known types.
3. For metadata/config/dynamic fields, use `jsonObjectSchema` or
   `jsonValueSchema`.
4. Run `ravi sdk returns validate --json` to verify.
5. Regenerate SDK artifacts if needed.
