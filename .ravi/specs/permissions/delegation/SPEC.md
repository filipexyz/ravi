---
id: permissions/delegation
title: "Delegation"
kind: capability
domain: permissions
capability: delegation
capabilities:
  - provider-runtime
  - roles
  - invocation-context
  - effective-capabilities
tags:
  - permissions
  - delegation
  - roles
  - contacts
applies_to:
  - src/access/delegated-actor.ts
  - src/access/actor.ts
  - src/permissions
  - src/runtime/runtime-request-context.ts
  - src/runtime/context-registry.ts
  - src/runtime/host-services.ts
  - src/omni/consumer.ts
  - src/contacts.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Delegation

## Intent

Delegation records who caused an execution and the bounds an admitted handoff
must preserve. The active runtime authority model is
`permissions/agent-identity`: the executor acts under its compartment-scoped
agent identity, with the chat-scoped user overlay when applicable.

Attributing a Console operation to a person is separate from granting tools.
A verified handoff MAY preserve that person's request without changing the
agent producer, executor, capability ceiling, or Console resource policy.

## Definitions

- `delegator`: principal that caused execution. For human inbound, this is normally `contact:<id>`.
- `executor`: agent that will run the provider turn.
- `surface`: chat, thread, route, instance, project, or session context where the invocation happened.
- `role`: reusable authority bundle assigned to a principal or surface. This
  is the canonical graph primitive for permission profiles/groups.
- `effective_capability`: capability that survived all delegation constraints and is present in the runtime context used by tools.

## Invariants

- Delegation MUST be explicit, auditable, and explainable.
- Effective authority for user-initiated execution MUST be derived by intersection, not union.
- A role MAY grant capabilities, but a role assignment MUST be scoped. Global role assignment is a conscious explicit operation, not the default.
- Provider-owned policy MAY further restrict authority. It MUST NOT expand
  authority beyond the executor agent ceiling or applicable turn bounds.
- The retired `delegate_<relation>` actor/surface substitutions MUST NOT be
  reintroduced into runtime context creation by a handoff.
- Unknown or unresolved actors MUST receive no delegated tool/executable/CLI/session/contact authority.
- A user-facing response channel is not the same as tool authority. Ravi MAY answer textually while denying tools.
- Break-glass authority MUST be distinguishable from normal delegated authority in traces and context provenance.
- Delegation grants SHOULD be temporary by default unless the operator explicitly marks them permanent.
- Apps, automations, chats, roles, contacts, and sessions MUST be represented as explicit subjects/objects when they carry authority.

## Canonical Formula

For a user-initiated turn, following `permissions/agent-identity` and
`permissions/user-overlay`:

```text
effective_caps =
  agent_identity_capabilities
  INTERSECT contact_chat_capabilities_when_chat_is_governed
  INTERSECT turn_capabilities_when_present
```

Where:

- The agent identity is materialized from the executor's provider-owned
  capabilities in the selected compartment.
- An ungoverned chat MUST NOT require an independent actor or surface grant.
- In a governed chat, contact grants only narrow the agent ceiling.
- Turn approvals, observer grants and applicable caller narrowing remain
  upper bounds; a handoff MUST NOT add or globalize capabilities.
- Internal handoffs retain their explicit agent producer; automations retain
  their own principal. Neither MUST infer authority from the last human
  speaker, thread creator, display name, or session attachment.

## Verified Console Actor Handoffs

- Only a host-issued turn and its verified context lineage MAY establish a
  delegated Console actor. An admission MUST bind `callerContextId`,
  `callerSessionKey`, `targetSessionKey` and `admittedAt` to the producing
  agent and receiving session. Wire shape alone is not authentication; the
  internal prompt transport MUST remain restricted to trusted producers.
- Every caller credential in the chain MUST have been valid at its admission.
  The current credential and its derived lineage MUST remain live. Missing,
  contradictory, cyclic, wrongly targeted, or unbound chains MUST fail closed.
- Queued delivery MAY retain the admitted person after normal caller
  completion, rotation or later expiry. Explicit revocation, removal of a
  grant used by the caller, profile reduction, or an ineligible/blocked/
  opted-out person MUST invalidate the affected attribution, including
  historical callers and their pending or active descendants.
- A verified chain ending at a resolved, eligible person MUST send that
  person's contact id to Console, including when that person is the operator.
  Console MUST resolve the current link, membership and resource ACL; the
  installation login MUST NOT become a fallback identity.
- Resolved `pending` or `discovered` group participants MUST NOT be rejected
  solely for that intake status: they may hold explicit scoped grants.
  Attribution itself MUST NOT add capabilities. Blocked, missing or opted-out
  people remain ineligible.
- The executor agent and agent-origin provenance MUST remain intact. This
  attribution MUST NOT grant global authority, revive a credential, change
  personal connector or Knowledge eligibility, or authorize unrelated work.
- `relayCallerContactId`, prompt text, trace labels and a prior human message
  MUST NOT independently authenticate an actor. Producers without a verified
  admission remain subject to their existing refusal/automation rules.

## Externally Governed Compartments

A provider MAY supply an authenticated, signed, short-lived authority grant
for one externally governed execution. That grant MUST materialize as an
explicit execution compartment; it MUST NOT rewrite the executor Agent's
ambient permissions.

For such a turn:

```text
effective_caps =
  accepted_provider_ceiling
  INTERSECT verified_turn_grant
  INTERSECT local_host_and_provider_guards
  INTERSECT applicable_approval
  INTERSECT runtime_constraints
```

- The accepted provider ceiling is a locally persisted maximum for one
  provider/subject binding and revision.
- The verified turn grant MAY replace ordinary actor/surface role expansion
  only inside that compartment.
- A grant MUST be bound to provider audience, subject/binding revision,
  operation or normalized arguments digest, expiry, and replay identity.
- Revocation, expiry, stale binding revision, invalid signature, failed local
  guard, missing approval, or runtime fencing MUST fail closed.
- Compartment authority MUST NOT become visible to unrelated chats, sessions,
  automations, providers, or direct local execution.
- Generic Ravi contracts MUST remain provider-neutral and MUST NOT ingest the
  provider's organizational Role vocabulary.

For app execution:

```text
agent:<agent-id> use app:<app-id>      # non-mutating app operation
agent:<agent-id> execute app:<app-id>  # mutating app operation
```

Manifest-declared permissions are requirements, not grants. A runtime context
with an `agentId` MUST authorize the app object before operation dispatch.

## Role Model

Roles SHOULD be modeled in the same relation graph whenever they affect execution.

Examples:

```text
contact:<contact-id> member role:owner
contact:<contact-id> member role:trusted-dev
chat:<chat-id> constrain role:public-chat
role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
role:trusted-dev execute group:sessions_read
role:public-chat use toolgroup:read-only
```

Role expansion MUST preserve provenance so a denial/allow trace can say whether the capability came from a direct grant, role membership, surface policy, route policy, or explicit turn approval.

## Profile Boundary

Permission profiles/groups MUST use the role model rather than ad-hoc arrays in
agent, app, contact, or session config.

- `role:<id> <relation> <object-type>:<object-id>` defines profile
  capabilities.
- `<principal> member role:<id>` assigns that profile to an actor-like
  principal.
- `<surface> constrain role:<id>` constrains authority on a chat, session,
  route, project, or similar surface.
- Profile grants and memberships MUST obey the same lifetime, revocation, and
  audit rules as direct grants.
- Profile expansion MUST happen before turn capability materialization and MUST
  retain provenance in the context.
- Direct permission checks and turn-scoped context materialization MUST agree on
  profile expansion semantics. If a profile affects delegated authority, the
  same role-derived capability must be explainable in both paths.
- Policy-managed profile membership MUST validate the full target role closure
  before materialization and after role changes. Forbidden broad/admin outputs
  in the role closure MUST revoke or suspend policy-owned memberships before
  the next authority check.
