---
id: credentials
title: "Credentials"
kind: domain
domain: credentials
capabilities:
  - broker
  - controls
tags:
  - secrets
  - security
  - providers
  - audit
applies_to:
  - src/credentials
  - src/cli/commands/credentials.ts
  - pocs/credential-broker
  - .ravi/specs/credentials/controls
owners:
  - rbbt-credentials
status: active
normative: true
---

# Credentials

## Intent

The credentials domain owns provider/action credentials used by Ravi to operate
external services such as Slack, Gmail, GitHub, cloud APIs, or future provider
actions.

This domain exists to keep provider secrets separate from runtime context keys
and runtime/model provider credential pools.

## Vocabulary

- Runtime context key: `RAVI_CONTEXT_KEY` / `rctx_*`; authenticates and
  authorizes a Ravi caller.
- Provider secret: a third-party token, API key, OAuth refresh token, session
  credential, or provider-native secret material.
- Connection: metadata that names a provider credential, for example
  `slack:rbbt`.
- Secret ref: a backend coordinate such as `keychain:<service>/<account>` or
  `vault:<mount>/<path>#<key>`.
- Broker: the only component allowed to resolve provider secret values for an
  action.

## Invariants

- Provider secrets MUST NOT be stored in `~/.ravi/credentials.json`.
- `~/.ravi/credentials.json` MUST remain scoped to runtime context keys.
- `ravi context credentials` MUST remain scoped to `RAVI_CONTEXT_KEY` /
  `rctx_*` management.
- `ravi runtime credentials` MUST remain scoped to runtime/model provider
  credential selection and health.
- `ravi credentials` MUST own provider/action connections and secret refs.
- Provider secrets MUST NOT appear in chat, prompts, stdout, JSON output, logs,
  traces, errors, audit rows, markdown, SQLite, or unencrypted local files.
- Persistent metadata MUST store secret refs only, never secret values.
- Persistent metadata MUST include lifecycle fields needed for safe operation:
  owner, purpose, scopes, status, created/updated timestamps, last used time,
  rotation time, expiration time and disabled time when available.
- Public CLI/SDK output SHOULD prefer stable connection ids and redacted backend
  aliases over raw backend coordinates.
- Local development SHOULD use macOS Keychain when available.
- Production SHOULD use Vault/KMS or an equivalent secret manager.
- The broker MUST validate both caller identity and capabilities before
  resolving a provider secret.
- Sensitive provider actions MUST request approval before resolving a provider
  secret.
- A provider action MUST require both:
  - `use:credential:<provider>:<connection>`
  - `execute:<provider>:<action>`
- Provider-specific integrations MUST call the broker instead of reading
  Keychain/Vault directly.
- Agents and CLIs MUST NOT ask users to paste real provider tokens in chat.
- If a provider token appears in chat/history/log output, it MUST be treated as
  exposed and rotated.
- Credentials changes MUST be evaluated against the lightweight controls in
  `credentials/controls`.

## Domain Boundaries

The credentials domain MAY depend on:

- Ravi runtime context resolution.
- Permission provider runtime.
- Approval service.
- Ravi SQLite DB for metadata and audit.
- Backend adapters for Keychain, Vault, KMS or equivalent stores.

The credentials domain MUST NOT depend on:

- `~/.ravi/credentials.json` for provider secrets.
- Runtime provider credential pool semantics.
- Agent prompt content as a secret transport.
- Provider-specific business logic inside generic backend adapters.

## Validation

- `ravi specs get credentials --mode full --json`
- `ravi specs get credentials/broker --mode full --json`
- `ravi specs get credentials/controls --mode full --json`
- `bun test pocs/credential-broker/broker.test.ts`
- When implemented: `bun test src/credentials/**/*.test.ts src/cli/commands/credentials.test.ts`

## Known Failure Modes

- Provider token stored in `~/.ravi/credentials.json` because the name
  "credentials" was interpreted as generic secret storage.
- Provider token printed by a CLI command because a backend read was exposed as
  user-facing output.
- Agent bypasses broker and calls `security` or Vault directly.
- `runtime.credentials` grows Slack/Gmail semantics and becomes ambiguous.
- Vault write overwrites sibling keys stored at the same KV v2 path.
- Keychain write leaks secret through process args in production.
- Audit/log rows include authorization headers, provider tokens or raw backend
  response bodies.
- Implementation satisfies broker behavior but lacks lifecycle/evidence fields,
  making later compliance work expensive.
