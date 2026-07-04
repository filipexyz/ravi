---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage - Checks"
kind: checks
domain: sdk
capability: schema
feature: returns-coverage
owners:
  - dev
status: active
---

# Checks

## Weak Schema Quality Gate

Default validation rejects any weak public return schema:

```bash
ravi sdk returns status --json
ravi sdk returns validate --json
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
```

- `weakPublic` MUST be `0`.
- `baselineWeakPublic` MUST be `0`.
- `newlyWeak` MUST be `[]`.
- `ravi sdk returns validate --json` MUST return `ok: true`.

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

## Coverage Audit

Run:

```bash
ravi sdk returns status --json
```

The output reports total public commands, typed public, binary, weak, and
CLI-only counts. Include relevant status output in PRs that change return
schemas.

## Artifact Drift

After changing public return schemas, verify generated artifacts are in sync:

```bash
ravi sdk openapi check --json
ravi sdk client check --json
ravi sdk swift check --json
```

These checks compare on-disk generated files against a fresh emit.
