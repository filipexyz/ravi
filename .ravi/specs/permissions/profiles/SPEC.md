---
id: permissions/profiles
title: "Permission Profiles"
kind: capability
domain: permissions
capability: profiles
capabilities:
  - provider-runtime
  - roles
  - agent-identity
  - capability-materialization
  - tag-policy
tags:
  - permissions
  - profiles
  - roles
  - delegation
  - least-privilege
applies_to:
  - src/permissions/provider-runtime.ts
  - src/permissions/delegation.ts
  - src/permissions/capability-context.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/context-registry.ts
  - src/omni/consumer.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permission Profiles

## Intent

Permission profiles are reusable authority bundles.

The product word MAY be "profile" or "permission group". In the active runtime
model, recurring operational authority SHOULD attach to the agent identity by
updating provider-owned executor agent runtime capabilities. A role/profile
grants capabilities to no one by itself. A principal receives those
capabilities only through explicit provider materialization.

Tags MAY be used to manage profile membership at scale, but only through
explicit permission policy materialization. A tag such as
`policy.profile.trusted-dev` MUST materialize `member role:trusted-dev` before
it has any authorization effect.

Profiles are also the primary operator UX for recurring authorization. Agents
SHOULD ask for a named profile/tag instead of emitting long lists of raw
capabilities. Capability lists are diagnostic evidence or bootstrap material
for creating a new profile, not the normal approval interface.

## Invariants

- Profiles MUST be fail-closed allow lists.
- Profiles MUST be represented in provider-owned policy state or in a runtime
  capability context derived from provider decisions.
- A profile MUST NOT grant authority unless a concrete principal or surface is
  linked to it by an explicit relation.
- Profile expansion MUST preserve provenance for every materialized
  capability.
- Profile expansion MUST be implemented consistently for direct permission
  checks and runtime context materialization. A `can()` check and an equivalent
  turn-scoped capability context MUST not disagree about role-derived
  authority.
- Profile grants SHOULD be temporary by default unless marked permanent.
- Revoked or expired profile grants and memberships MUST stop authorizing.
- Profile expansion MUST happen before turn-scoped capability materialization.
- A profile assignment to a contact is legacy/user-overlay unless an explicit
  provider consumes it for invocation eligibility.
- A profile assignment to a chat/surface is compartment policy or constraint;
  a missing chat profile MUST NOT zero agent identity authority.

## Canonical Relations

Examples:

```text
role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
role:trusted-dev execute group:sessions
role:trusted-dev use app:apps
role:trusted-dev use app:khal-tasks
role:trusted-dev execute app:khal-tasks

contact:<contact-id> member role:trusted-dev
agent:<agent-id> member role:trusted-dev
automation:cron:<job-id> member role:daily-ops
chat:<chat-id> constrain role:public-chat
session:<session-id> constrain role:project-room
```

Semantics:

- `role:<id> <relation> <object-type>:<object-id>` defines capabilities in
  the profile.
- `<principal> member role:<id>` assigns that profile to an actor-like
  principal.
- `<surface> constrain role:<id>` restricts what can happen on that surface.
- Surface constraints MUST NOT create authority absent from actor and executor
  ceilings.
- `constrain` is a first-class relation for surface-to-role constraints. The
  permissions CLI and relation validator MUST accept it before any
  tag-managed surface profile tests are considered implemented.

## Materialization

When building an agent identity runtime context, Ravi MUST:

1. Resolve the actor principal, executor agent, and surface principal.
2. Resolve the compartment (`chat`, `dm`, `automation`, or `workspace`).
3. Resolve executor agent capabilities from provider-owned runtime config.
4. Project those capabilities into
   `agent_identity:<agent-id>:<compartment-type>:<compartment-id>`.
5. Intersect with turn approval/observer capabilities when present.
6. Persist effective capabilities and provenance into the context.

Materialized capabilities MUST include source metadata such as:

- provider id/source;
- profile id;
- compartment id;
- executor agent source;
- reason/issuer when available.

## App Profiles

Apps MAY be exposed through provider-owned capabilities or profiles.

Preferred app profile pattern:

```text
role:ops-apps use app:apps
role:ops-apps use app:khal-tasks
role:ops-apps execute app:khal-tasks
  agent:<agent-id> member role:ops-apps
```

Rules:

- App manifest permissions are requirements, not profile grants.
- `use app:<id>` is required for discovery and non-mutating operations.
- `execute app:<id>` is required for mutating operations.
- A profile that allows mutating app operation SHOULD also include
  `use app:<id>` so the app is discoverable and inspectable.

## Tag-Managed Profiles

For human-scale management, policy tags SHOULD describe reusable profiles, but
the production default is to apply recurring tool authority to the agent
identity/executor agent. Contact tags are for legacy/user-overlay policy.

Example:

```text
tag contact:<contact-id> policy.profile.trusted-dev
policy:trusted-dev-contact-profile materializes:
  contact:<contact-id> member role:trusted-dev

role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
```

Rules:

- Tag-managed membership MUST be materialized by the tag/contact-policy
  provider, not by a shared grants table.
- Removing the tag and reconciling the policy MUST remove only membership
  owned by that policy source, not explicit agent runtime capabilities.
- Tag-managed membership MUST compute the target role closure before
  materialization. Membership into roles containing forbidden or undeclared
  sensitive capabilities MUST fail validation or require explicit break-glass
  approval with short TTL.
- Explain output MUST show the tag, policy rule, membership relation, and role
  grants that expanded from it.

## Agent Request UX

When a missing capability is recurring, the recommended request shape is:

```text
subject: <principal>
scope: <optional session/chat/app/resource>
profile/tag: <provider-owned profile id>
reason: <why this workflow needs it>
ttl: <temporary by default, permanent only when explicit>
```

Rules:

- Agents MUST treat the authorization guidance envelope as the canonical
  contract. Free-form CLI error text is for humans; JSON guidance is for
  agents.
- Agents MUST NOT ask for `full-access` unless explicitly told to request
  break-glass.
- Agents SHOULD run `ravi permissions materialize` before asking for new
  authority, so the request cites current state instead of guessing.
- Agents SHOULD prefer existing permission-scoped tags/profiles over creating
  ad-hoc capability lists.
- Approval/audit output MUST show the concrete capability diff behind the
  profile/tag when available.
- If the envelope names a provider-owned permission tag, agents SHOULD request
  that tag by slug. If no tag/profile matches, agents MAY propose the raw
  canonical capability as bootstrap material for a new narrow profile/tag.
- A one-off runtime approval MUST be phrased as "current context only" and MUST
  NOT imply a recurring grant.

## Operator Workflow UX

The default operator path for recurring authorization is:

```bash
ravi permissions resolve <denial-id>
ravi permissions resolve <denial-id> --apply
```

For agent-identity denials, `resolve` MUST infer `agent:<executorAgentId>`.

When no denial id exists, the default path is:

```bash
ravi permissions allow <profile> \
  --to agent:<executor-agent-id> \
  --capabilities <permission>:<objectType>:<objectId>

ravi permissions allow <profile> ... --apply
```

Semantics:

- `allow` and `resolve` MUST dry-run by default.
- `--apply` MUST be explicit for every provider-owned mutation.
- Applying a profile to `agent:<id>` MUST ensure the executor-agent runtime
  config contains the concrete capabilities, without replacing existing
  explicit capabilities.
- Applying a profile to `contact:<id>` MAY still use the contact policy path,
  but this is legacy/user-overlay and not the normal way to unblock
  multiplayer agent tool authority.
- Existing provider-owned permission tags MUST be reused when their capability
  set matches the denied capability.
- Non-permission tags MUST NOT be mutated by permission workflow commands.
- Surface/chat constraints require their own materializer. Until such a
  provider exists, the workflow command MUST not pretend that attaching a tag to
  a chat grants authority.

## Relationship To Tool Groups

`toolgroup:<name>` is not a generic permission group.

Tool groups are a shorthand object family used only when checking
`use tool:<tool-name>`. Permission profiles are subject-like bundles that can
grant tools, executables, CLI groups, apps, sessions, contacts, and future
objects.

## Acceptance Criteria

- A profile with app grants does not expose the app until a principal is a
  member of that profile.
- Removing a profile membership removes the materialized capabilities from the
  next runtime context.
- An expired profile grant is omitted from materialization.
- A chat constraint profile can reduce an owner's authority in that chat.
- Denial/audit output can identify whether a capability came from a direct
  grant or a profile.
