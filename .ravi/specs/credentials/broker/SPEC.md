---
id: credentials/broker
title: Credentials Broker
kind: capability
domain: credentials
capability: broker
tags:
  - credentials
  - broker
  - secrets
  - security
  - keychain
  - vault
applies_to:
  - src/credentials/
owners:
  - ravi-dev
status: draft
normative: true
---

# Credentials Broker

## Intent

The credentials broker is the single authorization and resolution gateway for all provider/action secrets in Ravi. Every caller that needs a secret value MUST request it through the broker, which checks authorization, validates connection state, resolves the secret ref through the configured backend, and returns the value for immediate use.

The broker exists so that:

- Authorization is always checked before any secret is read from storage.
- Backend implementation (Keychain, Vault, KMS, future backends) is abstracted from callers.
- Composite secrets are resolved atomically.
- Redaction and audit are centralized.
- Callers never learn backend coordinates or storage layout.

## Invariants

- The broker MUST check authorization before resolving any secret ref.
- The broker MUST fail closed when the connection status is not `active`.
- The broker MUST fail closed when the caller lacks the required capability for the requested secret/action.
- The broker MUST resolve composite secrets atomically: all parts succeed or the entire resolution fails.
- The broker MUST NOT return backend coordinates, storage paths, or Keychain item names to callers.
- The broker MUST NOT cache resolved secret values beyond the immediate caller response. Callers are responsible for ephemeral in-memory use and must not persist resolved values.
- Secret refs MUST be opaque identifiers that the broker maps to backend coordinates internally.

## Secret Backend Interface

```
SecretBackend {
  read(ref: SecretRef): Promise<string>          // resolve a secret ref to its value
  write(ref: SecretRef, value: string): Promise<void>  // store or update a secret
  delete(ref: SecretRef): Promise<void>          // remove a secret from storage
  exists(ref: SecretRef): Promise<boolean>       // check if a secret exists without reading
}
```

Implementations:

- **Keychain** (local default): macOS Keychain via `security` CLI or native bindings. Scoped to the Ravi service namespace.
- **Vault/KMS** (production): HashiCorp Vault, AWS KMS, or GCP KMS. Scoped to a configured path prefix.
- **File** (outside MVP): Only if a hardened spec requires 0700/0600 permissions, file lock, atomic write, and no arbitrary paths.

## Authorization Model

The broker enforces two layers of authorization for every resolution:

1. **Connection capability**: `use:credential:<provider>:<connection_id>` grants the caller permission to use the credential connection.
2. **Action capability**: A provider-specific action capability grants the caller permission to perform the requested action.

Both MUST pass. Examples:

### Slack (Channel Credentials)

- Connection: `use:credential:slack:<connection_id>`
- Actions:
  - `execute:slack:socket_mode.connect`
  - `execute:slack:messages.send`
  - `execute:slack:files.read`
  - `execute:slack:reactions.write`

### Runtime Providers (Existing)

- Runtime provider credentials continue to use the existing REBAC model from `runtime/providers/credential-fallback`.
- The broker provides secret resolution; the credential pool and fallback logic remain in the runtime credential resolver.

## Composite Secret Resolution

Some connections require multiple secret parts. The broker MUST:

1. Identify all secret refs for the requested connection and action.
2. Resolve all refs through the backend.
3. If any ref fails, return an error without partial results.
4. Return all resolved values in a single response.

### Native Slack Composite Secret

Slack connections model two secret parts under one connection:

- `app_token_ref`: Slack app-level token (`xapp-...`) for Socket Mode / `apps.connections.open`.
- `bot_token_ref`: Slack bot token (`xoxb-...`) for `chat.postMessage` and other Web API actions.

For `socket_mode.connect`, the broker resolves both atomically.
For `messages.send`, `files.read`, or `reactions.write`, the broker resolves only `bot_token_ref`.

The connection metadata includes workspace id, app id, bot user id, OAuth scopes, and lifecycle status. This metadata is NOT secret and MAY be returned without authorization checks beyond connection existence.

## Broker-Bound Provider Adapter Execution

Channel adapters and provider adapters MUST call the broker to obtain secrets. They MUST NOT:

- Read Keychain/Vault directly.
- Import or `require` backend modules.
- Cache resolved secrets in persistent storage (SQLite, files, runtime context keys).
- Pass resolved secrets to downstream processes except as ephemeral in-memory parameters for the immediate API call.

The broker is the adapter's only path to secret material.

## Redacted Secret Refs

When metadata, logs, CLI output, or audit records need to reference a secret, they MUST use the redacted alias from the connection metadata, not the raw value or backend coordinate.

Format: `<provider>:<workspace/account>:<part>:****`

Example: `slack:acme:bot-token:****`

## Connection Lifecycle

- `active`: broker resolves secrets on authorized request.
- `suspended`: operator or system suspended; broker refuses.
- `expired`: detected by preflight or external signal; broker refuses until refresh.
- `revoked`: externally revoked; broker refuses permanently until re-registration.

All transitions MUST be audited with actor, reason, and timestamp.

## Validation

- `ravi specs get credentials/broker --mode full --json`
- Broker resolution tests (follow-up implementation card)
- Authorization-before-read tests (follow-up implementation card)
- Composite secret atomicity tests (follow-up implementation card)
