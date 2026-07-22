---
id: apps/mercado-livre
title: "Mercado Livre Native App Checks"
kind: capability
domain: apps
status: active
normative: false
---

# Mercado Livre Native App / CHECKS

## Contract And Safety

- `confirmedOfficialContract` is true and every migrated matrix entry names an
  official source.
- Standard-price mutation and composite postage have no executable Ravi
  operation.
- Default authorization rejects before `fetch`.
- Provider errors redact credential-shaped values.
- No manifest or source file embeds a credential.
- No changed path belongs to the legacy SDE implementation.

## Permissions

- Non-mutating operations have `kind: read` access metadata.
- All mutations have `kind: mutate`, `requiresConfirmation: true` and a
  `--confirm` option.
- Reversible catalog writes use `ml:catalog:write`.
- Close/delete use `ml:catalog:destructive`.
- Answers/messages use `ml:communication:write`.
- Price, billing, shipment-cost and Product Ads reads use
  `ml:financial:read`; no financial mutation exists.

## Commands

```bash
bun test src/apps/mercado-livre/client.test.ts \
  src/apps/mercado-livre/app.test.ts \
  src/cli/commands/ml.test.ts
bun run gen:commands
bun run sdk:generate
bun run sdk:check
bun src/cli/index.ts apps check mercado-livre --json
bun src/cli/index.ts ml --help
bun src/cli/index.ts ml seller --json
bun run typecheck
bun test
bun run build
bunx biome check src/ .ravi/specs/apps/mercado-livre/
```

The `ml seller` check is expected to return the Phase 1 missing-credential error
without making a network request.
