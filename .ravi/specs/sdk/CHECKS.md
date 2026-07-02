---
id: sdk
title: "Ravi SDK - Checks"
kind: checks
domain: sdk
owners:
  - dev
status: draft
---

# Checks

## SDK artifact drift

Generated artifacts MUST be in sync with the live registry:

```bash
ravi sdk client check
ravi sdk openapi check
ravi sdk swift check
```

## Return schema quality

All public commands MUST have concrete return schemas:

```bash
ravi sdk returns status --json   # weakPublic must be 0
ravi sdk returns validate --json # must return ok: true
```

## Build and type safety

```bash
bun run typecheck
bun run build
```

## Test suites

```bash
bun test src/sdk/gateway
bun test src/sdk/client-codegen
bun test src/sdk/swift-codegen
bun test src/sdk/return-schemas
```
