# Channels Credentials / WHY

## Problem

Slack (and future native channels) requires provider-specific secrets to operate: an app token for Socket Mode and a bot token for Web API calls. Today these secrets have no formal home in Ravi.

Current risks without a credential contract:

- Secrets end up as raw env vars read directly by channel runner code. This makes them visible to any process in the env, hard to rotate, impossible to audit, and easy to leak into logs, traces, prompts, or error messages.
- There is no authorization gate between "a runner wants a token" and "a token is returned." Any code path that reads the env gets the secret.
- Composite secrets (app token + bot token) have no atomic resolution. A partial read (one token present, one missing) causes silent failures or degraded behavior.
- Channel config stores raw token values, making them visible in `ravi instances list --json`, SQLite dumps, backups, and migration exports.
- Runtime provider credentials (`runtime/providers/credential-fallback`) solve a related but distinct problem: model API keys for Claude/Codex/Pi. Channel secrets need their own metadata, lifecycle, and authorization model.

## Decision

Define a `channels/credentials` capability that:

1. Models Slack app token + bot token as a composite credential connection behind the generic credentials broker.
2. Requires explicit authorization (`use:credential:slack:<connection>` + action capability) before any secret is resolved.
3. Stores only secret refs and redacted aliases in Ravi metadata; raw secrets live in backend storage (Keychain, Vault, KMS).
4. Makes `ChannelInstance` reference a `credential_connection_id`, never raw token values.
5. Delegates all credential CRUD to the generic `ravi credentials` domain, preventing `ravi slack` from creating a parallel storage boundary.

## Why A Broker, Not Direct Backend Access

Channel adapters should not know how to read macOS Keychain or HashiCorp Vault. The broker provides:

- A single authorization checkpoint (REBAC capability check) before any secret read.
- Backend abstraction so the same adapter code works locally (Keychain) and in production (Vault/KMS).
- Atomic composite resolution so the runner never gets half a credential.
- Consistent redaction and audit across all secret consumers.

## Why Not Extend Runtime Provider Credentials

Runtime provider credentials are scoped to model API keys with pool selection, fallback chains, rate-limit classification, and provider session continuity. Channel credentials have different needs:

- No pool selection or fallback: a Slack connection has exactly one app token and one bot token.
- Different authorization model: action capabilities like `execute:slack:messages.send` instead of model/provider selection.
- Different lifecycle: Slack tokens can be revoked externally by workspace admins; runtime credentials are operator-managed API keys.
- Different metadata: workspace id, app id, bot user id, OAuth scopes.

The two domains share broker backend infrastructure but are separate metadata and authorization concerns.

## Why Env Vars Are Temporary

Env vars are acceptable for local smoke testing where a developer runs `SLACK_APP_TOKEN=xapp-... SLACK_BOT_TOKEN=xoxb-... ravi daemon start`. They are not acceptable for production because:

- They cannot be rotated without restarting the daemon.
- They are visible to all child processes.
- They have no authorization gate.
- They have no audit trail.
- They cannot model workspace/app identity or OAuth scopes.

The spec allows env fallback only as a temporary dev-mode input with a deprecation warning.

## Tradeoff

- The broker adds a resolution hop before every secret use. This is intentional: the hop is the authorization checkpoint.
- The metadata store adds a new table to `ravi.db`. This is necessary to track connection identity, status, and audit without storing secrets.
- The Keychain/Vault backends are new infrastructure. The first implementation can be Keychain-only with Vault deferred to a production card.
