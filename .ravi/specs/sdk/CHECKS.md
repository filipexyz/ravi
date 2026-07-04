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

- `ravi sdk client check` MUST pass with no drift detected.
- `ravi sdk openapi check` MUST pass with no drift detected.
- `ravi sdk swift check` MUST pass with no drift detected.

## Return schema quality

All public commands MUST have concrete return schemas:

```bash
ravi sdk returns status --json
ravi sdk returns validate --json
```

- `weakPublic` MUST be `0`.
- `baselineWeakPublic` MUST be `0`.
- `newlyWeak` MUST be `[]`.
- `ravi sdk returns validate --json` MUST return `ok: true`.

## Build and type safety

- `bun run typecheck` MUST pass with zero errors.
- `bun run build` MUST succeed.

## Test suites

- `bun test src/sdk/gateway` MUST pass.
- `bun test src/sdk/client-codegen` MUST pass.
- `bun test src/sdk/swift-codegen` MUST pass.
- `bun test src/sdk/return-schemas` MUST pass.
