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

## Consumption Authority

- Every secret resolution MUST enforce the two capabilities through the
  Permission Provider Runtime. Command authorization alone is insufficient.
- Runtime callers MUST resolve their explicit key or in-process context against
  the current persisted context and executor. Invalid, expired, revoked or
  missing contexts MUST NOT fall back to a default credential or local operator.
- The issued capability snapshot and current executor ceiling MUST both cover
  the request. Provider denial or `needs_approval` MUST stop before backend read.
- Sensitive runtime actions MUST obtain operation approval without adding a
  capability grant. After waiting, the broker MUST revalidate caller, current
  permissions, provider decision and unchanged active connection before reading.
- Trusted host entrypoints MAY explicitly select operator-control for direct
  local operator commands or named Slack infrastructure services. Internal
  service authority MUST be limited to its provider/action allowlist, MUST NOT
  be accepted from command arguments and MUST NOT override an active runtime
  invocation. Missing context alone MUST NOT authorize secret access.
- Local CLI provenance MUST distinguish a default credential loaded for
  convenience from an explicit runtime caller. A scoped default MUST NOT turn
  explicit host bootstrap into an agent invocation, and an invalid explicit
  key MUST NOT fall back to that default.
- Approval-card finalization MUST use the host delivery boundary instead of
  recursively consuming credentials under the waiting agent's context. That
  boundary MUST derive targets, terminal state and grant outcome from persisted
  approval records, never arbitrary text or destinations from an event payload.
- Audit MUST distinguish denied authorization, pending provider approval,
  operation approval and explicit operator-control. It MUST NOT manufacture an
  `allow` decision or retain backend exceptions that could contain plaintext.
- The current diagnostic `broker exec` MUST remain `@CliOnly` until it executes
  a real provider adapter. This fix does not make it a generic agent tool.

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
  kind: "file" | "keychain" | "vault";
  write(input: SecretWriteInput): Promise<SecretRef>;
  read(ref: SecretRef): Promise<string>;
  delete(ref: SecretRef): Promise<boolean>;
}
```

The `read` method is internal only. It MUST NOT be exported as a public CLI
command or SDK endpoint.

The default `file` backend MUST keep secret bytes in broker-owned private files
(0700 directory, 0600 files) with atomic writes and strict opaque references.
It is plaintext protected by the host account and works on headless Linux;
Keychain and Vault remain explicit alternatives. The backend MUST reject unsafe
paths, links and permissions rather than expose the secret through an error.

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
