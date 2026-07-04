---
id: sdk/schema
title: "SDK schema contract - Checks"
kind: checks
domain: sdk
capability: schema
owners:
  - dev
status: draft
---

# Checks

## Return schema quality

```bash
ravi sdk returns status --json
ravi sdk returns validate --json
```

- `weakPublic` MUST be `0`.
- `ravi sdk returns validate --json` MUST return `ok: true`.

## Schema coverage tests

```bash
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun test src/sdk/return-schemas
```

- Schema coverage tests MUST pass with zero failures.
- Return schema workflow tests MUST pass with zero failures.

## Gateway dispatch tests

```bash
bun test src/sdk/gateway/dispatcher.test.ts
```

- Gateway dispatcher tests MUST pass, including binary return handling.

## Type safety

- `bun run typecheck` MUST pass with zero errors.
