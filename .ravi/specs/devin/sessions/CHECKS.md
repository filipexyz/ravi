# Devin Sessions Checks

## Store Tests

```bash
bun test src/devin/store.test.ts
```

Validates:
- Upsert MUST be idempotent by `devin_id`
- Audit fields MUST persist through insert and update (user_id, service_user_id, mode, platform, etc.)
- Status and tag filtering MUST return correct subsets
- Message and attachment sync MUST be idempotent

## CLI Tests

```bash
bun test src/cli/commands/devin*.test.ts
```

Validates:
- Flag parsing MUST handle all session creation options
- Precedence MUST follow: explicit flag > env/config > omit
- JSON output shape MUST match return schemas

## Integration Smoke

```bash
ravi devin sessions list --json
ravi devin sessions show <known-id> --json
```

## Acceptance

- Local record MUST persist all audit fields from creation through sync
- `list` and `show` output MUST include sanitized audit metadata in JSON mode
- Secret values MUST NOT appear in any output or stored record
- ID normalization MUST handle both raw and prefixed input
