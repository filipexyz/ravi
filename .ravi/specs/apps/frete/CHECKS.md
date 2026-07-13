# Frete / CHECKS

## Contract And Manifest

```bash
bun src/cli/index.ts apps check frete --json
bun src/cli/index.ts apps show frete --json
bun src/cli/index.ts frete quote --help
```

Expected:

- manifest is valid and has no warnings;
- only `frete.quote` calls an external API;
- read/write/destructive/financial permissions are distinct;
- help states that quote is read-only and does not contract freight.

## Focused Tests

```bash
bun test src/apps/frete src/cli/commands/frete.test.ts
```

Expected:

- fake fetch receives the exact official URL, method and request shape;
- missing credential fails before fetch;
- no test uses a real connection or network;
- response validation and redaction are covered.

## Registry And SDK

```bash
bun run gen:commands
bun run sdk:generate
bun run sdk:check
bun run typecheck
bun run build
```

Expected:

- `frete.quote` has explicit input and return types;
- generated SDK files have no drift;
- build/typecheck complete without errors.
