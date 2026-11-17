# Credential Broker Checks

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/credentials/file-backend.test.ts src/credentials/backends.test.ts src/credentials/intake.test.ts`
- Verify private-file connection intake resolves through the existing broker and
  no token appears in connection metadata, logs, errors or audit.

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
- An invalid key never falls back to default credentials or operator-control.
- Stale in-process context copies cannot survive revocation or capability removal.
- A missing executor or blocked invocation actor cannot use a saved snapshot.
- Both the issued scope and current executor ceiling apply, including narrowed children.
- External provider `deny` and `needs_approval` prevent backend read, including
  after a local human approves a sensitive operation.
- Revocation or connection changes during approval prevent backend read.
- Named internal Slack bootstrap authority works without an invocation and
  cannot override an invocation, select another provider or run unrelated actions.
- Slack adapter resolution uses the checked broker path and does not expose the
  token in action output, audit or diagnostic errors (including nested causes).

Focused host-safe regression:

```bash
bun test --preload ./src/test/isolated-runtime-preload.ts src/credentials/broker-authorization.test.ts src/credentials/credentials.test.ts
```

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
