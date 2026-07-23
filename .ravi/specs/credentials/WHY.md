# Credentials Why

## Why This Domain Exists

Ravi already has runtime context keys and runtime provider credentials. Neither
is the right abstraction for provider/action secrets.

Runtime context keys answer: "who is calling Ravi, and what can they do?"

Provider/action credentials answer: "which external provider connection may
Ravi use for this action, and how can the secret be used without exposing it?"

Keeping these separate prevents the recurring confusion between `ravi context`
and `ravi credentials`.

## Decisions

### `ravi credentials` is a top-level domain

Provider/action credentials MUST live under `ravi credentials`, not
`ravi context credentials`.

Reason:

- `context` is identity and authorization material for Ravi.
- Provider credentials are external account secrets.
- The CLI wording should make misuse difficult.

### Metadata belongs in SQLite

Production metadata SHOULD live in Ravi-owned SQLite tables.

Reason:

- The rest of Ravi already uses SQLite for durable domain state.
- CLI pagination and SDK output can follow established patterns.
- Audit events need queryable state.
- JSON files are acceptable for the PoC but inefficient as a production
  ownership boundary.

### Secret values belong in secret backends

Provider secret values MUST live in Keychain, Vault/KMS, or an equivalent
secret manager.

Reason:

- SQLite is not an encrypted secret store.
- Chat/prompt/log surfaces are not secret stores.
- Backend-specific access can be hardened independently.

### The broker resolves secrets, not agents

Agents and generic CLIs MUST receive action results, not secret values.

Reason:

- Returning the secret to the caller expands the leak surface.
- The broker can audit intent and outcome without exposing material.
- Provider adapters can use the secret and discard it within the operation
  boundary.

### Runtime credentials are not reused

`runtime.credentials` SHOULD NOT store Slack/Gmail/provider-action credentials.

Reason:

- Runtime credentials select model/runtime accounts.
- Provider/action credentials authorize external service operations.
- Runtime credential health/fallback semantics do not match provider action
  permissions.

## Alternatives Rejected

- Store provider secrets in `~/.ravi/credentials.json`: rejected because that
  file is for runtime context keys.
- Add `ravi context credentials provider add`: rejected because it reinforces
  the wrong mental model.
- Reuse `runtime.credentials`: rejected because it saves files short term but
  creates domain debt.
- Require Vault only for MVP: rejected because local dev needs a safe, usable
  backend; Keychain is the correct local default on macOS.

## Tradeoffs

- A dedicated `src/credentials` domain adds files, but reduces long-term
  ambiguity.
- A generic broker API requires provider adapters, but prevents secret-oracle
  CLI commands.
- Vault KV v2 read-merge-write is convenient, but production should add CAS to
  prevent concurrent write loss.
