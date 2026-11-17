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
- Caller-supplied child metadata MUST NOT replace or erase `parentContextId`,
  `parentContextKind`, `issuedFor`, `issuedAt` or `issuanceMode`. A child MUST
  NOT impersonate a host-issued root for human bootstrap/relay attribution.
- Revocation reasons MUST be monotonic with respect to authority withdrawal:
  normal completion/rotation cleanup MUST NOT replace an explicit withdrawal
  (including an unnamed revoke) with a benign reason. A later explicit revoke
  MUST invalidate a previously completed context's admitted work.
- Public `context revoke --reason` text MUST be an audit note on an explicit
  withdrawal, never a selector for host completion/rotation semantics. Even
  a note matching a host cleanup reason MUST invalidate admitted human work.
- Daemon bootstrap admin detection MUST only consider `admin-bootstrap`
  contexts. Agent identity turn contexts that happen to snapshot
  `admin:system:*` MUST NOT count as bootstrap admin credentials.
- Any live `agent-runtime` context is historical residue and MUST be reported
  by production-readiness checks until revoked, expired, or migrated.
- Bulk cleanup of historical `agent-runtime` contexts MUST be opt-in and
  exposed through an explicit CLI path. It MUST NOT run automatically during
  dispatch or daemon startup.
- An active provider turn MAY renew its own `turn-runtime` lease before expiry,
  only after revalidating the original invocation against current authority.
  Renewal MUST preserve the issued key, capabilities, actor and surface; new
  grants MUST wait for the next turn. A reduced ceiling, ineligible actor,
  changed authorization mode or failed revalidation MUST revoke the context
  and its descendants. Token use/touch alone MUST NOT renew a context.
- Renewal MUST NOT revive an expired, revoked or deleted context, change the
  default TTL, renew derived children, or override bridge delegation expiry.
  `relayNarrowing` contexts MUST NOT renew: their historical caller snapshot
  does not yet encode every individual grant revocation in relay lineage.
  They retain their original expiry and require a new turn after it expires.
  The host-owned renewal timer MUST end on terminal settlement, failed turn
  preparation, generator closure or abort. Terminal settlement MUST revoke the
  turn key immediately; ordinary completion preserves independently issued
  children as existing turn rotation does, while abort cascades revocation.
- Session reset/abort MUST also revoke still-live derived credentials in that
  session whose turn root already completed. Ordinary launch reclamation with
  `cascade: false` MUST continue preserving independent child lifetimes.
- Context replacement MUST preserve the object reference retained by host
  services while removing optional fields absent from the new snapshot,
  including `revokedAt` and `source`. A live key in storage is insufficient if
  host tools still see stale revocation or surface state from the previous turn.
- Listing active contexts MUST select expiry candidates through the expiry
  index before loading historical context payloads. Retained expired history
  MUST NOT require a full payload scan on each global active-context lookup.
  Both expiry and revocation remain active only when absent, zero, or strictly
  later than the lookup timestamp. Agent, session and kind filters, descending
  creation order, and explicit `includeInactive` inspection MUST be preserved.
  This optimization MUST NOT cache authority decisions or delete audit history.

## Acceptance

- Ten turns in the same session create ten independently auditable
  `turn-runtime` records or equivalent invocation-scoped overlays.
- Every new dispatch context has `authorityMode=agent-identity`; none has
  `kind=agent-runtime`.
- Reset or abort revokes live runtime contexts for the session and the next
  dispatch issues a fresh agent-identity context.
- Stale historical contexts can be inspected in dry-run mode before any revoke.
- A turn active for longer than an hour remains authorized with its original
  capabilities, while a new grant never appears in that turn's snapshot.
