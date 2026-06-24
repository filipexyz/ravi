# Credential Broker Runbook

## Before Implementing

Read:

```bash
ravi specs get credentials --mode full --json
ravi specs get credentials/broker --mode full --json
```

Review the PoC:

```bash
ls pocs/credential-broker
bun test pocs/credential-broker/broker.test.ts
```

## Suggested Implementation Order

1. Create `src/credentials/types.ts`.
2. Create `src/credentials/store.ts` with SQLite metadata tables.
3. Create backend adapters under `src/credentials/backends`.
4. Port policy explanation into `src/credentials/policy.ts`.
5. Implement `src/credentials/broker.ts`.
6. Add audit writes in `src/credentials/audit.ts`.
7. Add `src/cli/commands/credentials.ts`.
8. Add return schemas and tests.
9. Run command generation.
10. Integrate first provider adapter, preferably Slack `auth.check`.

## Adding A Backend

Backend checklist:

- Implement `write`, `read`, `delete`.
- Validate and parse refs.
- Redact refs in public output.
- Return typed errors.
- Never log secret values.
- Add tests for missing secret, malformed ref, read, write and delete.

## Adding A Provider Adapter

Provider adapter checklist:

- Define allowed action names.
- Define sensitive actions.
- Define expected params schema.
- Execute with a secret supplied by broker.
- Return redacted result shape.
- Add an `auth.check` or equivalent smoke action first.

## Running A Dry Run

Dry run should prove policy without resolving secrets:

```bash
ravi credentials broker exec \
  --provider slack \
  --connection rbbt \
  --action auth.check \
  --dry-run \
  --json
```

Expected:

- Required capabilities are shown.
- `secretResolved` is false.
- No backend read occurs.

## Running A Real Action

Use a non-destructive provider action first:

```bash
ravi credentials broker exec \
  --provider slack \
  --connection rbbt \
  --action auth.check \
  --json
```

Expected:

- Authorization succeeds.
- Approval is not required for read-only auth check.
- Secret is resolved internally.
- Output contains no secret value.

## Troubleshooting

### Connection Not Found

- Check provider and connection ids.
- Check disabled/removed status.
- Check metadata table, not backend first.

### Permission Denied

- Run `policies explain`.
- Check `use:credential:<provider>:<connection>`.
- Check `execute:<provider>:<action>`.
- Check whether the call is running with `RAVI_CONTEXT_KEY`.

### Approval Missing

- Confirm the action is classified as sensitive.
- Confirm approval target exists for the runtime source.
- Denied approval should happen before secret resolution.

### Vault Failure

- Confirm `VAULT_ADDR` and `VAULT_TOKEN` exist without printing values.
- Confirm mount/path/key.
- Confirm KV v2 API shape.
- Do not log response bodies.

### Keychain Failure

- Confirm service/account ref.
- Confirm macOS Keychain is available.
- For production, do not use process-arg secret writes.

## Cleanup

Smoke tests must delete temporary backend secrets and temporary metadata rows.
