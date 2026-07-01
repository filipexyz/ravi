# Credentials Broker / CHECKS

## Authorization Before Backend Read

- Broker MUST check `use:credential:<provider>:<connection_id>` before any backend read.
- Broker MUST check the action capability before resolving secret material.
- A caller with connection capability but without action capability MUST be denied.
- A caller without connection capability MUST be denied regardless of action capabilities.
- Authorization checks MUST use the REBAC permission graph, not ad-hoc caller identity checks.

## Fail-Closed Behavior

- A connection with status `suspended` MUST fail closed before any backend read.
- A connection with status `expired` MUST fail closed before any backend read.
- A connection with status `revoked` MUST fail closed before any backend read.
- A missing connection id MUST fail closed with a clear error (no secret material returned).
- A connection with mismatched provider/workspace/account identity MUST fail closed.
- An unauthorized caller MUST receive a denial error without any indication of whether the secret exists.

## Composite Secret Atomicity

- When resolving a composite secret (e.g., Slack app token + bot token), all parts MUST succeed or the entire resolution MUST fail.
- Partial resolution MUST NOT return any secret parts.
- The caller MUST NOT receive a partial credential set.

## Native Slack Composite Secret

- Slack Socket Mode connect MUST resolve both `app_token_ref` and `bot_token_ref` atomically.
- Slack Web API actions (`messages.send`, `files.read`, `reactions.write`) MUST resolve only `bot_token_ref`.
- If `app_token_ref` is missing or unresolvable, Socket Mode connect MUST fail entirely.
- If `bot_token_ref` is missing or unresolvable, all Slack actions MUST fail.
- Connection metadata (workspace id, app id, scopes) MUST be accessible without resolving secrets.

## Redacted Secret Refs

- Redacted aliases MUST be stable and deterministic for a given connection/secret-part.
- Redacted aliases MUST NOT reveal raw secret values or backend coordinates.
- All broker error messages MUST use redacted aliases, not raw values.

## Backend Abstraction

- Callers MUST NOT receive backend coordinates (Keychain item names, Vault paths, KMS key ARNs).
- Backend implementation MUST be swappable (Keychain, Vault, KMS) without changing caller code.
- Backend failures MUST be surfaced as broker errors with redacted context, not raw backend exceptions.

## Broker-Bound Provider Adapter Execution

- Channel adapters (e.g., Slack runner) MUST call the broker for secrets.
- Channel adapters MUST NOT import or call Keychain/Vault modules directly.
- Resolved secrets MUST NOT be cached in SQLite, files, runtime context keys, or persistent storage.
- Resolved secrets MUST be used ephemerally for the immediate API call and then discarded.

## Connection Lifecycle Audit

- All status transitions (active -> suspended, active -> expired, etc.) MUST record actor, reason, and timestamp.
- Lifecycle events MUST be queryable for audit purposes.
- Revoked connections MUST NOT be re-activated without explicit re-registration.

## Validation Commands

```bash
ravi specs get credentials/broker --mode full --json
ravi specs get credentials/broker --mode checks --json
bun run typecheck
bun run build
```
