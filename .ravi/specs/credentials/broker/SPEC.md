---
id: credentials/broker
title: "Credential Broker"
kind: capability
domain: credentials
capabilities:
  - broker
tags:
  - secrets
  - keychain
  - vault
  - approval
  - audit
  - controls
applies_to:
  - src/credentials/broker.ts
  - src/credentials/backends
  - src/cli/commands/credentials.ts
  - pocs/credential-broker
owners:
  - rbbt-credentials
status: active
normative: true
---

# Credential Broker

## Intent

The credential broker is the boundary that turns an authorized provider action
request into a provider call using a secret that is never returned to the
caller.

The broker protects provider secrets from agents, chats, generic CLIs, logs and
audit surfaces while still allowing Ravi to perform approved external actions.

## Invariants

- The broker MUST be the only generic component that resolves provider secret
  values.
- The broker MUST NOT expose a user-facing command that prints or returns a
  provider secret.
- The broker MUST load connection metadata before resolving a secret.
- The broker MUST load lifecycle metadata before resolving a secret.
- The broker MUST reject disabled, missing or mismatched connections before
  resolving a secret.
- The broker SHOULD reject expired connections before resolving a secret.
- The broker MUST check `use:credential:<provider>:<connection>` before
  resolving a secret.
- The broker MUST check `execute:<provider>:<action>` before resolving a secret.
- The broker MUST request approval for sensitive actions before resolving a
  secret.
- The broker MUST write audit events without secret values.
- Provider adapters MUST receive secrets only inside the broker operation
  boundary.
- Provider adapters MUST return redacted action results.
- Backend adapters MUST return typed/redacted errors.
- Vault backend writes MUST preserve sibling keys at the same KV v2 path.
- Vault production writes SHOULD use KV v2 CAS/version checks.
- Keychain production writes MUST NOT pass secret values through process
  arguments.
- `broker exec --dry-run` MUST NOT resolve secrets.
- Public connection serialization MUST redact sensitive parts of secret refs.
- Public connection serialization SHOULD expose a stable `secretRefAlias` or
  redacted ref, not raw Vault paths by default.
- Successful broker use SHOULD update `lastUsedAt` without storing secret
  material.

## Broker Flow

1. Resolve caller context from `RAVI_CONTEXT_KEY`.
2. Load connection metadata by provider and connection id.
3. Explain required capabilities.
4. Authorize credential usage.
5. Authorize provider action execution.
6. Request approval if required.
7. Resolve the secret through the configured backend.
8. Execute the provider adapter.
9. Clear secret material from local scope as soon as possible.
10. Persist audit event.
11. Return action result without secret material.

## Backend Contract

Backend adapters MUST implement this internal shape:

```ts
interface CredentialSecretBackend {
  kind: "keychain" | "vault";
  write(input: SecretWriteInput): Promise<SecretRef>;
  read(ref: SecretRef): Promise<string>;
  delete(ref: SecretRef): Promise<boolean>;
}
```

The `read` method is internal only. It MUST NOT be exported as a public CLI
command or SDK endpoint.

## Provider Adapter Contract

Provider adapters SHOULD implement a narrow action executor:

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

Provider adapters MUST NOT store the secret value. They MAY return provider
metadata, status, ids and redacted errors.

## CLI Contract

`ravi credentials` SHOULD expose:

```text
ravi credentials connections list
ravi credentials connections show
ravi credentials connections add
ravi credentials connections remove
ravi credentials connections rotate
ravi credentials policies explain
ravi credentials broker exec
```

CLI commands MUST use:

- `@Group`
- `@Command`
- `@CommandAccess`
- `@Returns`
- standard pagination with `nextCommand`

`broker exec` MAY exist for testing and first integrations. It MUST behave as a
brokered action entrypoint, not as a generic secret-read command.

## Audit Contract

Audit events MUST include:

- provider
- connection
- action
- actor/context id when available
- agent/session when available
- capability decision
- approval requirement/status
- backend kind
- secret ref alias or redacted coordinate
- result status
- redacted error code/message

Audit events MUST NOT include:

- provider secret values
- authorization headers
- Vault tokens
- raw backend response bodies
- request bodies containing secrets
- chat prompt text containing secrets

## Validation

- `bun test pocs/credential-broker/broker.test.ts`
- When implemented: `bun test src/credentials/**/*.test.ts`
- When implemented: `bun test src/cli/commands/credentials.test.ts`

## Known Failure Modes

- `broker exec` becomes a secret oracle by returning the resolved secret.
- `--dry-run` resolves the secret accidentally.
- Sensitive action asks for approval after secret resolution.
- Authorization checks only action permission and forget credential usage.
- A provider adapter logs request headers with bearer tokens.
- Vault delete removes an entire shared path instead of only the configured key.
- Keychain adapter uses a PoC-safe implementation in production.
- Connection metadata stores a real token because `secretRef` validation is too
  loose.
