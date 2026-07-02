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
ravi sdk returns status --json    # weakPublic must be 0
ravi sdk returns validate --json  # must return ok: true
```

## Schema coverage tests

```bash
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun test src/sdk/return-schemas
```

## Gateway dispatch tests

```bash
bun test src/sdk/gateway/dispatcher.test.ts
```

## Type safety

```bash
bun run typecheck
```
