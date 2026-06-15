---
id: permissions
title: "Permissions"
kind: domain
domain: permissions
capabilities:
  - provider-runtime
  - cli-command-access
  - local-grants-provider
  - delegation
  - resource-visibility
  - profiles
  - tag-policy
  - runtime-context
  - least-privilege
  - explain
  - production-readiness
  - enterprise
tags:
  - permissions
  - provider-runtime
  - runtime
  - security
applies_to:
  - src/permissions
  - src/runtime
  - src/tags
  - src/tag-rules
  - src/contacts.ts
  - src/omni/consumer.ts
  - src/router/router-db.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permissions

## Intent

Ravi permissions define who can cause Ravi to read, execute, mutate, deliver, or disclose state.

The permission model MUST protect every authority-bearing surface: SDK tools, CLI groups, executables, sessions, contacts, chats, contexts, automations, observers, triggers, cron jobs, providers, and external gateways.

The Permission Provider Runtime is the only authorization surface for Ravi core.
Ravi core MUST NOT embed a native grant graph as policy. The active default
runtime providers are `local-operator` for direct local bootstrap and
`context-capabilities` for already materialized runtime capability snapshots.
Relation-store grants are legacy provider state and MUST NOT be part of the
default authorization chain.

## Invariants

- Ravi MUST fail closed when the effective principal, action, object, or context cannot be resolved.
- Permission checks MUST use canonical Ravi subjects and objects, not raw provider ids, display names, phone numbers, or chat titles.
- Contacts, agents, chats, sessions, automations, observers, roles, and system actors are distinct principals. A grant to one MUST NOT imply a grant to another unless explicit provider-owned policy says so.
- Groups/chats/threads are communication surfaces, not human users. They MAY constrain authority, but they MUST NOT replace the current actor principal.
- `contact_policies` status controls operational intake and reply eligibility. It MUST NOT be treated as tool/executable/CLI authorization by itself.
- Any policy that affects tool, executable, CLI, session, contact, app, or gateway authority MUST be represented as a provider decision, a runtime capability context derived from provider decisions, or provider-owned policy state.
- Tags MAY select permission policy rules, but tags MUST NOT be ambient permissions. Tag-driven authority MUST be materialized into provider-owned policy state before it can authorize runtime behavior.
- Runtime contexts MUST carry enough structured authority provenance to explain why a tool was allowed or denied.
- Runtime providers MUST be adapters. They MUST request authorization through the Permission Provider Runtime and MUST NOT call grant-store APIs directly.
- Discovery MUST be treated as disclosure. Runtime list, show, search, check,
  autocomplete, alias resolution, SDK discovery, and UI picker surfaces MUST
  filter to resources visible to the effective context.

## Subject Types

The Permission Provider Runtime MAY reason over multiple subject types. These are the canonical meanings:

- `agent`: Ravi agent identity and maximum technical authority.
- `contact`: canonical human or organization from `chat.db.contacts`.
- `platform_identity`: channel-specific identity linked to a contact or agent.
- `chat`: canonical communication surface from `ravi.db.chats`.
- `session`: runtime session.
- `role`: reusable authority bundle, similar to a Discord role.
- `automation`: cron, trigger, observer, workflow, or daemon-originated actor.
- `system`: break-glass or platform-owned actor.

## Authority Rule

External user-initiated execution MUST be authorized by the actor who caused the turn, the chat/surface where it happened, and the agent that will execute it.

Agent permission is a ceiling, not sufficient authority.

## Grant Lifetime

Provider-issued grants MUST carry lifetime metadata. Relation-store grant rows
are legacy provider-owned state and MUST NOT authorize runtime behavior unless
an explicitly configured compatibility provider is installed.

Canonical grant metadata:

- `grant_mode`: `temporary` or `permanent`.
- `expires_at`: epoch seconds when a temporary grant stops authorizing.
- `revoked_at`: epoch seconds when a grant was revoked.
- `reason`: optional operator/audit reason.
- `issued_by`: optional context/session/agent/operator that issued the grant.

Rules:

- New manual grants MUST be temporary by default.
- `permissions grant` and `permissions init` MUST require an explicit `--permanent` flag to create permanent manual grants.
- CLI-created temporary grants SHOULD default to a short TTL; the current default is one hour.
- `--ttl` and `--expires-at` MAY override the default temporary expiration.
- Existing relation-store grant rows without lifetime metadata MAY be inspected
  or migrated by legacy administration commands, but they MUST NOT silently
  re-enter the default runtime provider chain.
- Authorization checks MUST ignore expired or revoked grants.
- Operator/audit listing MUST be able to include expired and revoked grants without making them active again.

## Legacy Grant Retirement

Manual permanent grants are migration debt unless they are explicitly
re-created with current provenance, reason, and review intent.

The safe retirement path is:

1. Materialize the replacement authority through roles, scoped direct grants,
   or permission policies.
2. Preview legacy cleanup with `ravi permissions legacy`.
3. Revoke in bounded phases with `ravi permissions legacy --apply --confirm
   legacy-cleanup`.
4. Rotate or revoke runtime contexts that still carry retired capabilities.
5. Re-run the preview until no unwanted legacy candidates remain.

Rules:

- `ravi permissions legacy` MUST be dry-run by default.
- Applying cleanup MUST require an explicit confirmation token.
- The default legacy cleanup set MUST include only active
  `source=manual`, `grant_mode=permanent` wildcard or trailing-pattern
  grants.
- Object-specific permanent grants MAY be included only with an explicit
  option such as `--include-specific`.
- Config, bootstrap, policy-owned, temporary, expired, and revoked grants MUST
  be excluded from legacy cleanup unless a separate command explicitly targets
  them.
- Cleanup MUST use provider administration APIs, not direct SQL writes. Grant
  store APIs are valid only inside a provider-owned administration boundary.
- Broad `clear` is a break-glass/debug path, not the normal migration path.

### Bulk Revocation Safety

Confirmation tokens are ritual, not protection. Bulk revocation MUST be
guarded by impact analysis:

- Before applying, cleanup MUST simulate the result and report blast radius:
  how many subjects drop to zero active capabilities, broken down by subject
  type, including the count of chat surfaces that would deny everything in
  delegated mode.
- Cleanup MUST refuse to apply when the zero-capability blast radius exceeds
  a configured threshold, unless the caller passes an explicit break-glass
  flag in addition to the confirmation token. The threshold default SHOULD be
  small (single digits of subjects).
- Replacement coverage is a precondition: applying a cleanup that zeroes
  subjects MUST fail unless replacement authority (roles, scoped grants, or
  materialized policies) already covers those subjects, or the caller
  explicitly forces the gap with break-glass intent.
- Self-preservation MUST be detected and blocked: when the issuing context's
  own principals (its agent, resolved actor contact, or current chat surface)
  received grants inside the migration window while the cleanup removes
  equivalent authority from other subjects, the apply MUST require operator
  (human) approval, not agent self-confirmation.
- Every new bulk revocation MUST carry an explicit batch identity in addition
  to `revoked_at`; timestamp-only grouping is legacy diagnostic fallback, not a
  safe restore key.
- A bulk revocation batch MUST be reversible through a provider administration
  API (restore by batch), without hand-written SQL.
- Agents MAY plan and preview cleanups. Applying a cleanup above the blast
  radius threshold is an operator decision.

## App Objects

Apps are first-class authorization objects.

- Non-mutating app operations require an authorization decision equivalent to `use app:<app-id>` when executed under an agent/runtime context.
- Mutating app operations require an authorization decision equivalent to `execute app:<app-id>` when executed under an agent/runtime context.
- App manifest permissions describe app-level requirements. They are not grants.
- Direct local CLI execution with no principal MAY remain a break-glass operator path only through an explicit local-operator provider or documented bootstrap bypass. Any runtime execution with `agentId` MUST authorize through the Permission Provider Runtime.

## Resource Visibility

Resources MUST be isolated by default.

Canonical visibility capabilities:

- `view agent:<id>` for agent discovery beyond self.
- `access session:<id>` for session read/trace/list visibility beyond own
  session.
- `modify session:<id>` for session mutation beyond own session.
- `use app:<id>` for app discovery, manifest inspection, checks, help, and
  non-mutating app operations.
- `read_contact contact:<id>`, `read_own_contacts system:*`,
  `read_tagged_contacts system:<tag>`, or `write_contacts system:*` for
  contact discovery and reads.

Direct local CLI execution without a resolved principal MAY remain a full local
operator view. Runtime execution with an `agentId` MUST NOT use local discovery
as an authorization bypass.

Broad discovery surfaces MUST filter unauthorized rows. Direct lookups for
hidden resources SHOULD use a not-found-equivalent response to avoid
enumeration.

## Permission Profiles

Reusable permission groups SHOULD be modeled as `role:<id>` subjects/objects.

Roles are capability bundles, not ambient grants. A role/profile grants
authority only when a principal is explicitly linked to it, for example:

```text
role:trusted-dev use app:khal-tasks
role:trusted-dev execute app:khal-tasks
contact:<contact-id> member role:trusted-dev
```

Profile expansion MUST preserve provenance and MUST occur before delegated
authority intersection. A chat/session/route profile assignment constrains the
surface; it MUST NOT replace the actor principal or expand authority absent
from the actor and agent ceilings.

Delegated override grants use the relation prefix `delegate_`, for example
`chat:<chat-id> delegate_use tool:Bash` or
`agent:<agent-id> delegate_use tool:Bash`.

- `delegate_<relation>` MUST NOT be treated as a normal capability.
- During turn-scoped delegated context construction, `delegate_<relation>` MAY
  satisfy the actor branch for a resolved contact.
- A surface-level override MAY also satisfy that surface branch.
- An agent-level override MUST NOT bypass the current surface branch.
- No override may exceed the executor agent ceiling, turn approval ceiling,
  revocation, expiration, actor resolution, or explicit deny/block state.
- `delegate_admin` MUST be rejected or ignored; superadmin remains a separate
  break-glass/admin-delegated mode.

## Tag-Driven Policy

Tags are valid selectors for permission management, not permissions by
themselves.

The required shape is:

```text
tag_bindings -> permission policy rule -> provider-owned policy state -> effective capabilities
```

Rules:

- Normal classification tags such as `domain.*`, `function.*`, `state.*`, or
  `tier.*` MUST NOT change authority by themselves.
- Policy tags SHOULD use the `policy.*` namespace.
- A policy rule MUST explicitly consume a tag before that tag affects
  authorization.
- Policy rules MUST materialize concrete provider-owned grants or policy records
  with source `policy:<rule-id>` or equivalent provenance.
- Policy-generated grants MUST be temporary by default unless the rule
  explicitly marks them permanent.
- Policy materialization MUST NOT overwrite manual/config/test grants with the
  same semantic capability. Implementations that cannot store multi-source
  provenance in the active provider MUST keep a separate materialization ledger.
- Policy rules SHOULD prefer materializing role/profile membership such as
  `contact:<id> member role:trusted-dev` over many duplicated direct grants.
- Policy-managed role/profile membership MUST validate the target role closure.
  Membership into roles containing forbidden admin, broad wildcard, or
  undeclared sensitive outputs MUST fail closed or require explicit break-glass
  approval with short TTL.
- Direct policy-generated grants are acceptable for narrow surface exceptions,
  for example `chat:<id> delegate_use tool:Bash`.
- Policy rules MUST reject `delegate_admin` and `admin system:*`.
- Policy tag detach, policy disable, policy source distrust, and role closure
  changes MUST revoke or suspend policy-owned grants immediately and invalidate
  affected runtime contexts before the next authority check.
- Auto-tagging MAY classify assets, but it MUST NOT grant permissions directly.
  A policy rule that consumes auto-generated `policy.*` tags MUST explicitly opt
  in to the accepted tag source.

## CLI Scope Boundary

Decorator scope `open` MUST NOT be treated as authorization bypass for runtime
execution.

- Direct CLI execution without a resolved principal MAY run `open` commands.
- When `agentId` or a runtime context exists, `open` commands MUST require
  `execute group:<group>` or `execute group:<group>_<command>`.
- `resource` scope MAY still perform resource-owner checks in the command layer,
  but it MUST NOT be used for sensitive mutation without a resource owner.
- Sensitive command groups SHOULD migrate away from `open` once their resource
  object model is explicit.

## Grant Notifications

When an operator creates manual grants through the permissions CLI, Ravi SHOULD emit a session prompt to currently affected sessions.

Minimum behavior:

- `agent:<id>` grants notify active sessions for that agent.
- `session:<id>` subject/object grants notify that concrete session.
- Notifications are advisory. Failure to publish a notification MUST NOT roll back the grant.
- Provider decisions and the denial ledger remain authoritative; the notification only lets a previously blocked session retry.

## Audit Denied Provenance

`ravi.audit.denied` MUST carry enough safe runtime provenance for an auditor to distinguish agent grants from delegated turn authority.

Minimum event fields:

- `type`, `agentId`, `denied`, `reason`, `dedupeKey`.
- `dedupeKey` MUST be stable for semantically equivalent denials and MUST NOT include `denialId`, timestamps, context keys, or other per-attempt entropy.
- `command` when a CLI or Bash command caused the denial.
- `denialId` when the denial was persisted in `permission_denials`.
- `context.contextId`, `context.kind`, `context.sessionKey`, `context.sessionName`.
- Delegated authority metadata when present: `authorityMode`, `authorityResolver`, `actorPrincipal`, `actorResolution`, `surfacePrincipal`, `executorAgentId`, `delegationOverridePrincipals`.
- Capability counts when present: `actorCapabilityCount`, `surfaceCapabilityCount`, `actorOverrideCapabilityCount`, `surfaceOverrideCapabilityCount`, `turnCapabilityCount`, `effectiveCapabilityCount`, `capabilitiesCount`.
- When `turnCapabilityCount > 0`, audit provenance MUST include the safe
  serialized `turnCapabilities` capability tuples (`permission`, `objectType`,
  `objectId`, optional `source`) so denial explain can preserve the turn
  upper-bound. Counts alone are not enough to reproduce the decision.

Diagnosis rules (see `permissions/explain` for the full contract):

- A zero or blocking branch MUST report its grant state: `never_granted`,
  `revoked`, `expired`, `constrained`, or `ceiling`.
- When the blocking branch lost matching grants to a bulk revocation batch,
  the diagnosis MUST reference that event (count, timestamp, issuer) instead
  of presenting the subject as never granted.
- Capability counts are point-in-time snapshots from context creation and
  MUST NOT be presented as live graph state.

The audit event and `permission_denials.detail_json` MUST NOT include `contextKey`, raw secret env values, credentials or arbitrary runtime metadata.

## Known Failure Modes

- A bulk legacy cleanup runs before replacement authority is materialized,
  zeroing every chat surface; delegated intersection then denies everything
  while denials recommend per-tuple re-grants that rebuild the wildcard debt
  (2026-06-10 incident: ~16k relations revoked in two batches, only the
  issuing session's principals survived because it granted itself, its
  operator contact, and its own chat first).
- An agent self-confirms a destructive permission migration; the confirmation
  token gates intent but not blast radius, so a single turn can revoke the
  whole graph including the admin authority needed to repair it.
- Authority is managed as thousands of direct wildcard tuples instead of role
  memberships; the graph becomes unauditable, operators default to
  full-access templates per subject, and any cleanup attempt has a
  catastrophic blast radius.
- Denial diagnoses present point-in-time capability counts as live state;
  operators chase stale numbers instead of querying current grants.
- Direct agent checks and delegated context materialization drift in role or
  override semantics, so `can()` and a real turn disagree about the same
  capability.
