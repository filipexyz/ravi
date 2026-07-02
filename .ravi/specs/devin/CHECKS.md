# Devin Checks

## Unit Tests

```bash
bun test src/devin/client.test.ts
bun test src/devin/store.test.ts
```

## CLI Integration

```bash
ravi devin auth check --json
ravi devin sessions create --help
ravi devin sessions list --json
```

## Return Schema Validation

```bash
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
bun test src/sdk/client-codegen/codegen.test.ts
ravi sdk returns validate --json
```

## SDK/OpenAPI Generation

```bash
bun run gen:commands
bun run sdk:generate
bun run sdk:check
```

## Spec Sync

```bash
ravi specs sync --json
ravi specs get devin --mode full --json
ravi specs get devin/sessions --mode full --json
ravi specs get devin/sessions/api --mode full --json
```

## Acceptance Criteria

- [ ] `ravi devin sessions create --help` shows v3 flags (mode, platform, resumable, etc.)
- [ ] Client tests prove v3 fields sent only when explicit/configured
- [ ] CLI tests prove flag > env/config > omit precedence
- [ ] Store tests prove audit fields survive insert/update/list/show/sync
- [ ] Return-schema validation: no newly weak Devin command schemas
- [ ] SDK/OpenAPI reflects concrete Devin payload schemas
- [ ] Low ACU is never silently hidden; Devin remains external executor in docs
