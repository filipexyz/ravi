# Devin Sessions Checks

## Store Tests

```bash
bun test src/devin/store.test.ts
```

Validates:
- Upsert idempotency by `devin_id`
- Audit field persistence (user_id, service_user_id, mode, platform, etc.)
- Status and tag filtering
- Message and attachment sync

## CLI Tests

```bash
bun test src/cli/commands/devin*.test.ts
```

Validates:
- Flag parsing for all session creation options
- Precedence: explicit flag > env/config > omit
- JSON output shape matches return schemas

## Integration Smoke

```bash
ravi devin sessions list --json
ravi devin sessions show <known-id> --json
```

## Acceptance

- Local record persists all audit fields from creation through sync
- `list` and `show` output includes sanitized audit metadata in JSON mode
- No secret values appear in any output or stored record
- ID normalization handles both raw and prefixed input
