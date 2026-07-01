---
id: channels/credentials
title: Channels Credentials
kind: capability
domain: channels
capability: credentials
tags:
  - channels
  - credentials
  - slack
  - broker
  - security
applies_to:
  - src/channels/
  - src/credentials/
owners:
  - ravi-dev
status: draft
normative: true
---

# Channels Credentials

## Intent

Channel runners such as Slack need provider-specific secrets (app tokens, bot tokens, OAuth credentials) to connect to external services and execute actions. These secrets MUST be managed through the Ravi credentials broker, not scattered across env vars, channel config, runtime context keys, or channel runner code.

This spec defines how native Ravi Channels (starting with Slack) reference, resolve, and consume provider/action secrets through the generic `credentials` domain and its broker abstraction.

## Current Reality

- Slack channel support does not yet exist as a native Ravi channel runner.
- The `cli/slack` spec describes a future `ravi slack` CLI surface but does not define credential storage or broker integration.
- The `runtime/providers/credential-fallback` spec governs runtime provider credentials (Claude, Codex, Pi) and defines the credential pool, secret binding, and env injection patterns. Channel credentials are a distinct concern: they are provider/action secrets for channel adapters, not runtime model credentials.
- Slack tokens currently exist only as env vars (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`) in local smoke/dev-mode setups. These are temporary inputs with explicit migration language; production Slack MUST NOT rely on raw env vars.

## Terminology

- **Credential connection**: A broker-managed record that binds one or more secret parts to a provider/workspace/account identity. For Slack, a connection groups an app token and a bot token under one Slack workspace/app identity.
- **Credential connection id**: A stable, opaque identifier for a credential connection (e.g., `slack:workspace-acme:app-ravi-bot`).
- **Secret ref**: A pointer to a secret value stored in a backend (Keychain, Vault, KMS). Ravi metadata stores the ref, never the raw secret.
- **Redacted alias**: A human-readable label for a secret ref that can appear in logs, CLI output, specs, and audit without revealing the secret value (e.g., `slack:acme:bot-token:****`).
- **Composite secret**: A credential connection that requires multiple secret parts resolved atomically (e.g., Slack app token + bot token).
- **Channel instance binding**: The association between a `ChannelInstance` and a `credential_connection_id`.
- **Credentials broker**: The generic Ravi service that stores metadata, resolves secret refs through backends, checks authorization, and provides resolved secrets to authorized callers.

## Invariants

### Secret Residency

- Provider/action secrets MUST live behind the credentials broker backend, not in Ravi runtime context keys, runtime/model credential pools, channel config, markdown, SQLite, prompts, logs, traces, or public output.
- Slack tokens MUST NOT be stored in SQLite, markdown, `~/.ravi/credentials.json`, runtime context keys, runtime/model credential pools, prompts, logs, traces, or CLI/JSON output.
- `ChannelInstance` / channel runner config MUST reference `credential_connection_id` and redacted aliases/secret refs, never raw `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, or equivalent token values.

### Env Var Migration

- Slack production behavior MUST NOT rely on raw env vars.
- Existing env vars (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`) MAY remain only as temporary local smoke/dev-mode inputs with explicit migration language.
- When the credentials broker is available, the Slack runner MUST prefer broker-resolved secrets over env vars. Env fallback MUST emit a deprecation warning.

### Composite Secrets

- Native Slack MUST model app token and bot token as a composite connection or related broker-bound secret parts under one Slack credential contract.
- The composite connection MUST be resolved atomically: both secret parts MUST be available before the runner uses either.
- The Slack credential contract MUST include at minimum:
  - `app_token`: for Socket Mode / `apps.connections.open`
  - `bot_token`: for `chat.postMessage` and other Slack Web API actions
  - workspace/team id
  - app id
  - bot user id (when known)
  - OAuth scopes granted
  - connection status and lifecycle metadata

### Broker Interaction

- Slack adapters MUST call the credentials broker and MUST NOT read Keychain/Vault directly.
- The broker MUST check both `use:credential:slack:<connection>` and action capabilities before resolving secret material:
  - `execute:slack:socket_mode.connect`
  - `execute:slack:messages.send`
  - `execute:slack:files.read`
  - `execute:slack:reactions.write`
- Disabled, expired, missing, mismatched, or unauthorized Slack connections MUST fail closed before backend secret read.
- The broker MUST verify the caller's authorization before returning any secret material. Authorization is checked against the REBAC permission graph.

### Redaction

- Public output, CLI JSON, logs, audit, traces, errors, prompts, and Notion/spec text MUST redact token values, authorization headers, raw backend secret coordinates, and Slack request bodies containing secrets.
- Redacted aliases MUST be stable and deterministic for a given connection/secret-part.
- Error messages from broker resolution failures MUST NOT include raw secret values or backend coordinates.

### Backend Preference

- Local default SHOULD be macOS Keychain.
- Production SHOULD be Vault/KMS.
- File fallback is outside MVP unless a hardened spec explicitly requires 0700/0600 permissions, lock, atomic write, and no arbitrary paths.

### CLI Domain

- Any future `ravi channels credentials` facade MUST delegate to the generic `ravi credentials` domain.
- `ravi slack` (from `cli/slack`) MUST NOT create a storage boundary or parallel credential store.
- The generic `ravi credentials` domain is the single entry point for credential CRUD, status, and diagnostics.

## Slack Connection Model

A Slack credential connection represents one Slack app installation in one workspace:

```
SlackCredentialConnection {
  connection_id:       string           // e.g., "slack:T0123ACME:A0456RAVI"
  provider:            "slack"
  workspace_id:        string           // Slack team/workspace id (T...)
  workspace_name:      string           // human-readable workspace name
  app_id:              string           // Slack app id (A...)
  bot_user_id?:        string           // Slack bot user id (U...)
  
  // Secret refs (never raw values)
  app_token_ref:       SecretRef        // -> backend coordinate for xapp-... token
  bot_token_ref:       SecretRef        // -> backend coordinate for xoxb-... token
  
  // Metadata
  scopes:              string[]         // OAuth scopes granted to the bot token
  status:              "active" | "suspended" | "expired" | "revoked"
  locked_by?:          string           // app/workspace lock to prevent conflicts
  created_at:          ISO8601
  updated_at:          ISO8601
  last_verified_at?:   ISO8601
  
  // Channel instance binding
  channel_instance_ids: string[]        // ChannelInstance ids bound to this connection
  
  // Audit
  created_by:          string           // actor who registered the connection
  redacted_alias:      string           // e.g., "slack:acme:ravi-bot:****"
}
```

### Status Lifecycle

- `active`: connection is usable; broker resolves secrets on authorized request.
- `suspended`: operator or system suspended; broker refuses secret resolution.
- `expired`: token expiry detected; broker refuses until refresh or re-registration.
- `revoked`: Slack revoked the token; broker refuses permanently until re-registration.

Transitions MUST be audited with actor, reason, and timestamp.

## Authorization Model

Secret resolution requires two capability checks:

1. **Connection capability**: `use:credential:slack:<connection_id>` grants the caller permission to use the credential connection.
2. **Action capability**: one of:
   - `execute:slack:socket_mode.connect` (establish Socket Mode WebSocket)
   - `execute:slack:messages.send` (call `chat.postMessage` and related APIs)
   - `execute:slack:files.read` (access Slack file URLs)
   - `execute:slack:reactions.write` (add/remove reactions)

Both checks MUST pass before the broker resolves secret material. A caller with `use:credential:slack:*` but without the specific action capability MUST be denied.

## Broker Resolution Flow

```
Slack runner requests secret for action "messages.send":
  1. runner calls broker.resolve(connection_id, action: "messages.send")
  2. broker checks connection status -> fail closed if not "active"
  3. broker checks use:credential:slack:<connection_id> -> fail closed if denied
  4. broker checks execute:slack:messages.send -> fail closed if denied
  5. broker resolves bot_token_ref through backend (Keychain/Vault)
  6. broker returns { bot_token: <resolved_value> } to runner
  7. runner uses bot_token for Slack Web API call
  8. resolved secret is never persisted, logged, or returned to caller beyond the immediate use
```

For Socket Mode connect, the broker resolves both `app_token_ref` (for `apps.connections.open`) and `bot_token_ref` (for event handling) atomically.

## Boundary With Runtime Provider Credentials

Channel credentials and runtime provider credentials are distinct domains:

- **Runtime provider credentials** (`runtime/providers/credential-fallback`): API keys, OAuth tokens, and auth profiles for model providers (Claude, Codex, Pi). Managed under `ravi runtime credentials`.
- **Channel credentials** (`channels/credentials`): Provider/action secrets for channel adapters (Slack, future channels). Managed under `ravi credentials`.

The two domains share the same broker backend infrastructure (Keychain, Vault, KMS) but have separate metadata stores, authorization models, and CLI surfaces.

## Validation

- `ravi specs get channels/credentials --mode full --json`
- `ravi specs get channels/credentials --mode checks --json`

## Known Failure Modes

- Slack runner reads tokens from env vars in production instead of calling the broker.
- Composite secret is partially resolved (app token without bot token) and the runner proceeds with an incomplete credential set.
- `ChannelInstance` config stores raw token values instead of `credential_connection_id`.
- Broker resolves secrets without checking action capabilities, allowing a caller with `use:credential` but no `execute:slack:messages.send` to obtain the bot token.
- Token revocation in Slack is not reflected in connection status, causing silent failures.
- Redaction misses a code path and raw token appears in logs or error messages.
- `ravi slack` CLI creates a parallel credential store instead of delegating to `ravi credentials`.

## Follow-Up Cards

This spec-only package identifies the following implementation cards:

1. **Credential metadata store** (`src/credentials/`): SQLite tables for credential connections, secret refs, secret bindings, status/lifecycle, and audit metadata. Shared infrastructure between runtime credentials and channel credentials.
2. **Keychain backend**: macOS Keychain adapter for the credentials broker. Implements `SecretBackend` interface for local development.
3. **Vault/KMS backend**: HashiCorp Vault or cloud KMS adapter for the credentials broker. Implements `SecretBackend` interface for production.
4. **`ravi credentials` CLI**: Generic credential management commands (`add`, `list`, `status`, `disable`, `enable`, `remove`, `test`). Replaces/wraps `ravi runtime credentials` for the unified credential domain.
5. **Slack runner -> broker integration**: Wire the Slack channel runner to call `broker.resolve()` instead of reading env vars. Implement composite secret resolution for app token + bot token.
6. **Focused secret-safety tests**: Authorization before backend read, dry-run without read, disabled/expired fail-closed, redaction in error/log/audit, Slack runner without token in prompt/event.
