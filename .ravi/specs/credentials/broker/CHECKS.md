# Credential Broker Checks

## PoC Regression

```bash
bun test pocs/credential-broker/broker.test.ts
```

## Production Regression

When production files exist:

```bash
bun test src/credentials/**/*.test.ts src/cli/commands/credentials.test.ts
```

Core validation before merging:

```bash
bun run typecheck
bun run build
```

## Dry Run Checks

`broker exec --dry-run` MUST:

- Return required capabilities.
- Return approval requirement.
- Return `secretResolved=false`.
- Not call backend `read`.
- Not create provider-side effects.

## Authorization Checks

Tests MUST cover:

- Missing connection denies before backend read.
- Disabled connection denies before backend read.
- Missing `use:credential:<provider>:<connection>` denies before backend read.
- Missing `execute:<provider>:<action>` denies before backend read.
- Sensitive action requests approval before backend read.
- Approval denial prevents backend read.

## Lifecycle Checks

Tests SHOULD cover:

- Disabled connection denies before backend read.
- Expired connection denies before backend read.
- Successful broker execution updates `lastUsedAt`.
- Rotation updates `rotatedAt` and keeps output redacted.
- Removing a connection can optionally delete backend secret material.

## Secret Redaction Checks

Tests MUST assert that these surfaces do not include secret values:

- CLI JSON output.
- Human CLI output.
- thrown errors.
- audit events.
- log events.
- provider action result.

Search changed files before closing:

```bash
rg -n "secretResolved|secretRef|redact|console\\.(log|error|warn)" src/credentials src/cli/commands/credentials.ts pocs/credential-broker
```

Review every output path manually.

## Backend Checks

Keychain:

- Write dummy secret.
- Read through broker only.
- Delete backend secret.
- Confirm item not found after cleanup.

Vault:

- Write dummy secret to KV v2.
- Preserve sibling keys.
- Read through broker only.
- Delete only the configured key when siblings remain.
- Redact missing key and HTTP errors.
- Add CAS/version check before production concurrent usage.

## Audit Checks

Audit rows MUST include:

- provider
- connection
- action
- context/agent/session identifiers when available
- decision
- approval status
- secret ref alias/redacted coordinate
- result status

Audit rows MUST NOT include:

- provider token
- Vault token
- authorization header
- backend response body
- request body containing secret material

## CLI Checks

`ravi credentials connections list` MUST use standard pagination fields:

- `total`
- `pagination.limit`
- `pagination.offset`
- `pagination.returned`
- `pagination.hasMore`
- `pagination.nextCommand`
- `items`

All commands MUST have `@CommandAccess` metadata.
