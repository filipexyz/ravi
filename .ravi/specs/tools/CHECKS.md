# Tools / CHECKS

## Discovery Commands Are Read-Only

- `tools list`, `tools search`, `tools show`, `tools manifest`, and
  `tools schema` MUST NOT call `tool.handler`.
- `tools test` MUST NOT call `tool.handler`.

## Real Execution Is Explicit

- Only `tools invoke` MUST call `tool.handler`.
- `tools invoke` MUST be annotated with `mutate/high` access metadata.

## Return Schemas Are Concrete

- All SDK-facing tools commands MUST have concrete `@Returns(zod)` schemas.
- New commands MUST NOT introduce `z.unknown()` or `z.any()` without adding
  to the weak return-schema baseline.
