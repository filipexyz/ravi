---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage - Checks"
kind: checks
domain: sdk
capability: schema
feature: returns-coverage
owners:
  - dev
status: draft
---

# Checks

## Coverage Audit

Run:

```bash
bun -e 'import "reflect-metadata"; import { getRegistry } from "./src/cli/registry-snapshot.ts"; const exposed=getRegistry().commands.filter(c=>!c.cliOnly); const withReturns=exposed.filter(c=>!!c.returns).length; const binary=exposed.filter(c=>c.binary).length; const byGroup={}; for (const c of exposed) { const g=c.groupSegments[0] ?? "root"; byGroup[g] ??= { exposed:0, returns:0, binary:0 }; byGroup[g].exposed++; if (c.returns) byGroup[g].returns++; if (c.binary) byGroup[g].binary++; } console.log(JSON.stringify({exposed:exposed.length, withReturns, withoutReturns:exposed.length-withReturns, binary, byGroup}, null, 2));'
```

The output SHOULD be included in PRs that claim return-coverage improvements.

## Regression Tests

For each non-trivial added `@Returns` schema, add or update at least one of:

```bash
bun test src/sdk/gateway/dispatcher.test.ts
bun test src/sdk/client-codegen
bun test src/sdk/swift-codegen
bun test src/cli/commands/<group>.test.ts
```

Also run:

```bash
bun run typecheck
bun run build
```

## Weak-Baseline Quality Gate

The weak-baseline test ensures that `newlyWeak` is empty and
`strengthenedButStillListed` is empty:

```bash
ravi sdk returns status --json
ravi sdk returns validate --json
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
```

- `newlyWeak` MUST be empty. Fix by adding concrete `@Returns` schemas.
- `strengthenedButStillListed` MUST be empty. Fix by removing the command
  from `WEAK_PUBLIC_RETURN_COMMANDS_BASELINE`.
- See `RUNBOOK.md` for step-by-step diagnosis.
