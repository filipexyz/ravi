---
id: permissions/profiles
title: "Permission Profiles"
kind: capability
domain: permissions
capability: profiles
capabilities:
  - rebac
  - roles
  - delegated-authority
  - capability-materialization
  - tag-policy
tags:
  - permissions
  - profiles
  - roles
  - delegation
  - least-privilege
applies_to:
  - src/permissions/relations.ts
  - src/permissions/delegation.ts
  - src/permissions/capability-context.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/context-registry.ts
  - src/omni/consumer.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Permission Profiles

## Intent

Permission profiles are reusable authority bundles.

The product word MAY be "profile" or "permission group", but the current
canonical graph primitive is `role:<id>`. A role/profile grants capabilities
to no one by itself. A principal receives those capabilities only through an
explicit membership or scoped delegation relation.

Tags MAY be used to manage profile membership at scale, but only through
explicit permission policy materialization. A tag such as
`policy.profile.trusted-dev` MUST materialize `member role:trusted-dev` before
it has any authorization effect.

## Invariants

- Profiles MUST be fail-closed allow lists.
- Profiles MUST be represented in the REBAC graph or in a capability context
  derived from the graph.
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
- Profile expansion MUST happen before turn-scoped capability intersection.
- Profile expansion MUST NOT union around surface constraints.
- A profile assignment to a chat/surface is a constraint by default, not actor
  identity.

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

When building a delegated runtime context, Ravi MUST:

1. Resolve the actor principal, executor agent, and surface principal.
2. Resolve direct actor capabilities.
3. Expand actor profile memberships into actor capabilities.
4. Resolve direct executor agent capabilities.
5. Expand executor profile memberships into agent capabilities.
6. Resolve surface constraints.
7. Expand surface profile constraints.
8. Intersect agent, actor, surface, and turn capabilities.
9. Persist the effective capabilities and provenance into the context.

Materialized capabilities MUST include source metadata such as:

- direct grant id/source;
- profile id;
- membership relation;
- surface constraint relation;
- expiration/revocation state;
- reason/issued_by when available.

## App Profiles

Apps MAY be exposed through direct grants or profiles.

Preferred app profile pattern:

```text
role:ops-apps use app:apps
role:ops-apps use app:khal-tasks
role:ops-apps execute app:khal-tasks
contact:<contact-id> member role:ops-apps
```

Rules:

- App manifest permissions are requirements, not profile grants.
- `use app:<id>` is required for discovery and non-mutating operations.
- `execute app:<id>` is required for mutating operations.
- A profile that allows mutating app operation SHOULD also include
  `use app:<id>` so the app is discoverable and inspectable.

## Tag-Managed Profiles

For human-scale management, policy tags SHOULD assign principals or surfaces to
profiles rather than duplicating large grant sets.

Example:

```text
tag contact:<contact-id> policy.profile.trusted-dev
policy:trusted-dev-contact-profile materializes:
  contact:<contact-id> member role:trusted-dev

role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
```

Rules:

- Tag-managed membership MUST be materialized into `relations`.
- Tag-managed membership MUST default to temporary grants unless the policy
  rule explicitly marks it permanent.
- Removing the tag and reconciling the policy MUST remove only membership
  owned by that policy, not manual memberships.
- Tag-managed membership MUST compute the target role closure before
  materialization. Membership into roles containing forbidden or undeclared
  sensitive capabilities MUST fail validation or require explicit break-glass
  approval with short TTL.
- Explain output MUST show the tag, policy rule, membership relation, and role
  grants that expanded from it.

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
