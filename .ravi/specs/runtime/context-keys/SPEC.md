---
id: runtime/context-keys
title: "Runtime Context Keys"
kind: capability
domain: runtime
capability: context-keys
tags:
  - runtime
  - context-keys
  - permissions
applies_to:
  - src/runtime/context-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/router/router-db.ts
  - src/cli/commands/context.ts
  - src/cli/context.ts
  - src/cli/remote-gateway.ts
  - src/cli/host-cli-gateway.ts
  - src/security/private-files.ts
  - packages/ravi-os-sdk/src/inherit.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Context Keys

## Intent

Runtime context keys are opaque credentials that connect provider turns, Ravi tools, child CLIs, audit records, and capability checks to one durable Ravi runtime context.

## Rules

- Every new provider dispatch MUST issue a `turn-runtime` context with
  `metadata.authorityMode=agent-identity`.
- Dispatch MUST NOT create or reuse `agent-runtime` contexts for active
  authorization.
- The runtime context MUST be scoped to the invocation and must carry the
  executor agent, session key, actor resolution, compartment, source metadata,
  materialized capabilities, and provenance needed for audit.
- External inbound turns with unresolved human actor identity MUST fail closed
  by materializing no tool/executable/CLI/session authority.
- Internal or local prompts without an external source MAY use the workspace
  compartment `agent_identity:<agent-id>:workspace:default`.
- Child contexts issued from a `turn-runtime` context MUST remain derived
  credentials and MUST NOT bypass `resolveRuntimeContext`.
- A process with a non-blank `RAVI_CONTEXT_KEY` acts only for that key. When
  the key does not resolve (unknown, revoked, expired, or from another
  install), CLI context resolution MUST NOT fall back to the
  `~/.ravi/credentials.json` default credential or to legacy `RAVI_AGENT_ID` /
  `RAVI_SESSION_*` identity. The caller is marked unresolved: it has no agent
  and no capabilities and is never the local operator.
- Daemon bootstrap admin detection MUST only consider `admin-bootstrap`
  contexts. Agent identity turn contexts that happen to snapshot
  `admin:system:*` MUST NOT count as bootstrap admin credentials.
- Any live `agent-runtime` context is historical residue and MUST be reported
  by production-readiness checks until revoked, expired, or migrated.
- Bulk cleanup of historical `agent-runtime` contexts MUST be opt-in and
  exposed through an explicit CLI path. It MUST NOT run automatically during
  dispatch or daemon startup.
- `ravi.db` (which holds context records) and its `-wal`/`-shm` files MUST be
  owner-only: a missing db is created empty with mode `0600` before SQLite
  opens it (its `-wal`/`-shm` inherit that mode), and an existing one loses its
  group/other bits on every open when it is a regular file owned by the current
  user. Symlinks and files owned by another user are left alone,
  `RAVI_STATE_DIR_KEEP_PERMISSIONS=1` opts out, and a failure never stops the
  open. The credential broker DB, `chat.db` (message contents) and
  `insights.db` follow the same rule.
- Context keys MUST be stored as digests: `contexts.context_key` holds
  `kh1:` + base64url(sha256(key)), never the key. The plaintext key is handed
  back exactly once, in the record `dbCreateContext` returns at issuance
  (`ravi daemon init-admin-key`, `ravi context issue`, turn and child
  issuance); every other read of a record (`dbGetContext`, `dbListContexts`,
  revoke results, `ravi context list|info|revoke`) carries the digest or no key
  at all. A key is looked up by its digest; a stored digest presented as a
  bearer MUST NOT resolve. Rows written by an older Ravi still hold plaintext:
  lookups accept them until the daemon hashes them at boot
  (`migrateContextKeysToDigest`, one idempotent transaction with a logged
  count). Precedence is deterministic: a lookup resolves the digest row first
  and consults a plaintext row only when no digest matched, whatever the
  insertion order. The migration never overwrites a plaintext row whose
  digest another row already holds; it skips it and logs the skipped context
  ids (ids only, never keys). Only daemon boot runs that migration, never
  `getDb()`, so a newer CLI cannot hash rows an older daemon still looks up by
  plaintext. `ravi doctor` reports plaintext rows
  (`runtime.context_keys_at_rest`) with their context ids (capped at 20, plus
  the total) and the remedies: restart the daemon, and revoke the listed
  contexts if rows remain. Digests are irreversible: rolling back to a Ravi
  that looks keys up by plaintext invalidates every migrated key; turn and
  child contexts reissue on the next turn, and the admin bootstrap key is
  re-imported with `ravi daemon init-admin-key --from-env`.
- Generated context keys are `rctx_` + base64url of 18 random bytes
  (`randomBytes(18)`: 144 bits, 24 characters). The unsalted digest relies on
  that randomness, so `ravi daemon init-admin-key --from-env` MUST refuse a
  `RAVI_BOOTSTRAP_KEY` shorter than `rctx_` + 24 characters with an error that
  states the minimum.
- Accepted edge: a row whose stored value starts with `kh1:` is treated as a
  digest, so a legacy plaintext key that itself started with `kh1:` would never
  resolve and never be migrated. `dbCreateContext` refuses such keys and
  generated keys start with `rctx_`, so the row is reachable only by editing
  the database by hand.
- A CLI sends its context key as a bearer token to `RAVI_GATEWAY_URL`. An
  `http:` URL MUST be refused with `REMOTE_GATEWAY_INSECURE` (exit 2) unless its
  host, as WHATWG URL parsing reads it, is `localhost` or a literal
  127.0.0.0/8 or `::1` address. There is no override; use `https:` or `unix://`.
  The SDK's `createInheritedClient` applies the same rule to the URL it
  resolves (`RAVI_BASE_URL`, `RAVI_HTTP_BASE_URL`, `RAVI_GATEWAY_URL`,
  `RAVI_HTTP_HOST`/`RAVI_HTTP_PORT` or an explicit `baseUrl`) and throws with
  `code: "REMOTE_GATEWAY_INSECURE"` before sending any request.
- A starting daemon MUST NOT unlink the host CLI gateway socket while another
  process accepts connections on it, nor a path that is not a socket owned by
  the current user; it starts without the gateway instead. The public socket
  name is claimed atomically (listen on a private name in the same directory,
  then `link(2)`), so of daemons starting at once exactly one serves it; only a
  dead socket of ours is moved aside, and the claim is retried once. Stopping
  the gateway MUST NOT remove a socket file that another daemon bound after it.

## Acceptance

- Ten turns in the same session create ten independently auditable
  `turn-runtime` records or equivalent invocation-scoped overlays.
- Every new dispatch context has `authorityMode=agent-identity`; none has
  `kind=agent-runtime`.
- Reset or abort revokes live runtime contexts for the session and the next
  dispatch issues a fresh agent-identity context.
- Stale historical contexts can be inspected in dry-run mode before any revoke.
