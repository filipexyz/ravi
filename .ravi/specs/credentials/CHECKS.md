# Credentials Checks

## Spec Checks

```bash
ravi specs get credentials --mode full --json
ravi specs get credentials/broker --mode full --json
ravi specs get credentials/controls --mode full --json
```

## PoC Checks

```bash
bun test pocs/credential-broker/broker.test.ts
```

## Production Checks

When `src/credentials` exists:

```bash
bun test src/credentials/**/*.test.ts src/cli/commands/credentials.test.ts
```

Before closing a CLI-facing change:

```bash
bun run typecheck
bun run build
```

## Secret Output Checks

Credentials commands MUST NOT print secret values.

Use targeted searches around changed files. If a match contains a real secret,
do not paste it into chat.

```bash
rg -n "console\\.(log|error|warn).*secret|secret.*console\\.(log|error|warn)" src/credentials src/cli/commands/credentials.ts pocs/credential-broker
rg -n "authorization|x-vault-token|bearer|access[_-]?token|refresh[_-]?token" src/credentials src/cli/commands/credentials.ts pocs/credential-broker
```

Expected result:

- No command output path prints secret values.
- Errors redact secret material.
- Audit/log paths record intent and outcome only.

## Control Coverage Checks

Every production credentials change SHOULD identify which internal controls are
affected:

- `CRED-ID`: caller identity and context.
- `CRED-AUTH`: capability and approval.
- `CRED-STORE`: secret backend storage.
- `CRED-USE`: broker action boundary.
- `CRED-OUTPUT`: redaction and output safety.
- `CRED-LIFE`: lifecycle and rotation.
- `CRED-AUDIT`: audit/evidence.
- `CRED-BACKEND`: backend failure and resilience.
- `CRED-CHANGE`: tests and change gates.
- `CRED-INCIDENT`: leak response.

## Boundary Checks

Provider/action credentials MUST NOT be implemented in runtime context storage:

```bash
rg -n "slack|gmail|provider secret|secret_ref|secretRef" src/runtime/credentials-store.ts src/cli/commands/context.ts
```

Provider/action credentials SHOULD NOT be added to runtime credential pool
semantics:

```bash
rg -n "slack|gmail|provider action|use:credential" src/runtime/credential-store.ts src/cli/commands/runtime-credentials.ts
```

Expected result:

- Matches should be absent or explicitly explain a boundary.

## Keychain Real Smoke

Use only a generated dummy secret.

Expected result:

- Add succeeds.
- Broker exec returns `secretResolved=true`.
- Remove returns `secretDeleted=true`.
- Direct Keychain lookup returns item not found after cleanup.

## Vault Checks

Contract tests MUST validate:

- KV v2 read shape.
- Write preserves sibling keys.
- Delete removes only the configured key when siblings exist.
- Missing key errors are redacted.
- HTTP errors do not print response bodies or tokens.

Real Vault smoke MAY run only when `VAULT_ADDR` and `VAULT_TOKEN` are already
configured in the environment.
