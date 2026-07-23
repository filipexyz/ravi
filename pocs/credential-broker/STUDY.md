# Ravi Credentials Broker Study

## Question

Is the current isolated PoC the most efficient path to implement `ravi credentials`
with secure Keychain/Vault save and read?

## Short Verdict

The PoC is good evidence, but it should not be promoted as-is.

The efficient implementation path is a new first-class domain under
`src/credentials`, with:

- SQLite metadata owned by the credentials domain.
- Backend adapters for `keychain` and `vault`.
- A broker service that resolves secrets only inside the operation boundary.
- A thin top-level CLI group: `ravi credentials`.
- Permission and approval checks through the existing Ravi context/capability
  runtime.

Do not implement this under `ravi context`, and do not reuse
`runtime.credentials` as the provider-action credential store.

## Current Repo Boundaries

There are already three adjacent concepts:

1. Runtime context keys
   - Files: `src/runtime/credentials-store.ts`, `src/cli/commands/context.ts`
   - Purpose: store/select `RAVI_CONTEXT_KEY` / `rctx_*` for the Ravi runtime.
   - Storage: `~/.ravi/credentials.json`.
   - Not for provider secrets.

2. Runtime provider credentials
   - Files: `src/runtime/credential-store.ts`,
     `src/cli/commands/runtime-credentials.ts`
   - Purpose: select credentials for model/runtime providers such as Claude,
     Codex, Pi, upstream model accounts, auth profiles, env bindings.
   - This has useful patterns: SQLite tables, pagination, command decorators,
     health tracking.
   - It is not the right domain for Slack/Gmail/provider action credentials.

3. Provider/action credentials PoC
   - Files: `pocs/credential-broker/*`
   - Purpose: validate `ravi credentials` connections, Keychain/Vault backends,
     policy explanation and broker execution without exposing secret values.
   - This is the right domain, but it is still isolated and lacks Ravi runtime
     authorization/approval/audit integration.

## What The PoC Proves

The current PoC proves the core shape:

- `connections add --secret-stdin` keeps secret input out of CLI flags.
- Public output returns metadata and redacted refs, not secret values.
- Keychain write/read/delete works in a real macOS Keychain smoke test.
- Vault KV v2 writes preserve sibling keys via read-merge-write.
- Vault delete removes only the configured key when other keys remain.
- `broker exec` resolves the secret in-process and returns only
  `secretResolved`.

The unit test suite currently covers metadata redaction, capability expression,
Keychain ref redaction and Vault KV v2 merge/delete behavior.

## What The PoC Does Not Prove Yet

- It does not authorize with `RAVI_CONTEXT_KEY`.
- It does not call `authorizeRuntimeContext` / `canWithCapabilityContext`.
- It does not request approval for sensitive provider actions.
- It does not write an audit trail.
- It uses JSON file metadata, not Ravi-owned SQLite.
- It has no provider adapter boundary; `broker exec` is still a fake action.
- Keychain writes use the macOS `security` CLI with `-w`, which passes the
  secret through process arguments during write. Acceptable for PoC only.
- Vault read-merge-write should use KV v2 CAS/version checks before production
  to avoid lost updates under concurrent writes.

## Options Considered

### Option A: Keep The PoC Shape And Move Fast

Move `pocs/credential-broker` into the app mostly as-is.

Pros:

- Fastest code movement.
- Already tested for the basic backend shape.

Cons:

- Keeps file JSON metadata instead of Ravi DB ownership.
- Duplicates CLI conventions instead of using decorators/return schemas.
- Authorization and approval remain bolted on later.
- Harder to expose as dynamic tools/SDK safely.

Decision: not efficient beyond prototype.

### Option B: Reuse `runtime.credentials`

Extend the existing runtime credential pool to include Slack/Gmail/etc.

Pros:

- Reuses existing SQLite tables, status, health and CLI patterns.
- Less new code up front.

Cons:

- Wrong semantics: runtime credentials select model/provider accounts; action
  credentials grant external provider actions.
- Health/selection logic for model fallback is unrelated to user-facing
  provider connections.
- It will confuse `runtime.credentials`, `context credentials` and
  `ravi credentials`, which is exactly what this workstream is avoiding.

Decision: not efficient; creates durable conceptual debt.

### Option C: New `src/credentials` Domain

Create a focused credentials broker domain.

Pros:

- Correct ownership and vocabulary.
- Reuses Ravi patterns without mixing semantics.
- Clean path to CLI, dynamic tools, SDK, policy, approval and audit.
- Easy first integration with Slack.

Cons:

- More files than simply moving the PoC.
- Needs schema/return types and command registration.

Decision: recommended path.

### Option D: Vault-Only From Day One

Skip local Keychain and require Vault/KMS everywhere.

Pros:

- Production-aligned backend.
- Avoids local secret storage decisions.

Cons:

- Slower local development.
- Harder real tests for agents without configured Vault.
- Pushes dev operators toward insecure workarounds.

Decision: not efficient for MVP. Keep Keychain for local dev and Vault/KMS for
production.

## Recommended Architecture

Create:

```text
src/credentials/
  types.ts
  store.ts
  backends/
    keychain.ts
    vault.ts
    index.ts
  broker.ts
  policy.ts
  audit.ts
src/cli/commands/credentials.ts
src/cli/commands/credentials.test.ts
```

The CLI should be thin. It parses arguments, calls domain services, and prints
safe return shapes.

The broker should be the only layer that resolves a secret value. CLI commands
may create, rotate or delete secrets, but must never print or return them.

## Data Model

Use SQLite in the Ravi DB, not `.state/connections.json`.

Suggested tables:

```sql
credential_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  label TEXT,
  backend TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, connection)
);

credential_connection_scopes (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES credential_connections(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  UNIQUE(connection_id, scope)
);

credential_audit_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_context_id TEXT,
  agent_id TEXT,
  decision TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  approval_status TEXT,
  result_status TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL
);
```

Store only metadata and secret refs. Never store provider secret values in
SQLite.

## Backend Contract

Use backend adapters, but keep secret values out of generic command output.

Recommended internal interface:

```ts
interface CredentialSecretBackend {
  kind: "keychain" | "vault";
  write(input: SecretWriteInput): Promise<SecretRef>;
  read(ref: SecretRef): Promise<string>;
  delete(ref: SecretRef): Promise<boolean>;
}
```

The `read` method should remain an internal broker/backend API. It should not
be reachable as a `ravi credentials read-secret` command.

For production hardening:

- Keychain: replace `security add-generic-password -w` with a native
  Security.framework binding or a helper that receives secret material over
  stdin/IPC.
- Vault: support KV v2 CAS writes and typed errors; avoid logging response
  bodies.
- Secret refs: consider public aliases in CLI output if Vault paths are
  operationally sensitive.

## Policy Contract

For a provider action:

```text
use:credential:<provider>:<connection>
execute:<provider>:<action>
```

The PoC already models this correctly.

Production broker flow:

1. Resolve `RAVI_CONTEXT_KEY`.
2. Load connection metadata.
3. Check `use:credential:<provider>:<connection>`.
4. Check `execute:<provider>:<action>`.
5. Request approval when the action is sensitive.
6. Resolve secret inside broker.
7. Call provider adapter with the secret.
8. Return action result without secret.
9. Write audit event with actor, connection, action, decision and outcome.

Use the existing permission runtime instead of a new permission stack:

- `canWithCapabilityContext`
- `authorizeRuntimeContext`
- command metadata via `@CommandAccess`

## CLI Shape

Top-level group:

```text
ravi credentials connections list
ravi credentials connections show
ravi credentials connections add
ravi credentials connections remove
ravi credentials connections rotate
ravi credentials policies explain
ravi credentials broker exec
```

Implementation should use the existing decorator system:

- `@Group({ name: "credentials", scope: "admin" })`
- `@Command`
- `@CommandAccess`
- `@Returns`
- `buildCliOffsetPagination`

The `broker exec` command is useful for the first integration and tests, but
for production provider flows it should become a thin entrypoint over provider
adapters, not a general secret oracle.

## Most Efficient Implementation Plan

### Phase 1: Promote Contracts, Not The PoC CLI

- Move types, store interface, backend interface and broker policy into
  `src/credentials`.
- Add SQLite metadata tables and tests.
- Keep the PoC directory as reference until parity is achieved.

### Phase 2: Add `ravi credentials`

- Implement `src/cli/commands/credentials.ts`.
- Add return schemas for JSON output.
- Add pagination with `nextCommand`.
- Run command generation instead of manually editing the command barrel.

### Phase 3: Backend Adapters

- Port Keychain and Vault adapters behind the backend interface.
- Keep Keychain CLI adapter marked as local-dev.
- Add Vault KV v2 tests for merge, read, delete and error redaction.

### Phase 4: Broker Authorization And Audit

- Resolve runtime context.
- Enforce credential/action capabilities.
- Add approval for sensitive actions.
- Persist audit events without secrets.

### Phase 5: First Provider Integration

- Integrate Slack first.
- Define a small provider adapter contract:

```ts
interface CredentialProviderActionAdapter {
  provider: string;
  execute(input: {
    connection: CredentialConnectionRecord;
    action: string;
    secret: string;
    params: Record<string, unknown>;
  }): Promise<CredentialActionResult>;
}
```

- Start with safe actions such as `auth.check`, then gated write actions.

## Acceptance Criteria

- No provider secret appears in stdout, JSON output, logs, errors or audit
  events.
- `~/.ravi/credentials.json` remains only for runtime context keys.
- `ravi context credentials` remains about `rctx_*`, not provider secrets.
- `ravi runtime credentials` remains about runtime/model provider selection.
- `ravi credentials` owns Slack/Gmail/etc provider connections.
- The broker refuses execution without both credential and action capability.
- Sensitive actions request approval before resolving a secret.
- Keychain real smoke passes on macOS.
- Vault KV v2 contract tests pass without a real Vault.
- Real Vault smoke is available when `VAULT_ADDR` and `VAULT_TOKEN` are set.

## Final Recommendation

Use the PoC as a reference implementation, not as production structure.

The most efficient path is Option C: implement a dedicated `src/credentials`
domain with SQLite metadata, backend adapters, policy/approval/audit, and a
thin `ravi credentials` CLI.

This minimizes conceptual debt while reusing the Ravi systems that already
exist: runtime context, command decorators, permission provider runtime,
approval flow, SQLite patterns and dynamic tool export.
