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

Delegation defines how a user, chat, route, automation, or system actor lends authority to an agent for one execution.

The model is Discord-role-like: nothing is available by default, and capabilities are unlocked only by explicit grants on principals or roles. Broad agent grants remain useful as a technical ceiling, but they MUST NOT become ambient authority for every person who can speak to that agent.

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
- Chat or route policy MAY further restrict authority. It MUST NOT expand authority beyond the actor and agent ceilings.
- Explicit `delegate_<relation>` overrides MAY replace a missing actor grant only inside delegated context materialization. They MUST NOT become ambient capabilities or exceed the executor agent ceiling.
- Unknown or unresolved actors MUST receive no delegated tool/executable/CLI/session/contact authority.
- A user-facing response channel is not the same as tool authority. Ravi MAY answer textually while denying tools.
- Break-glass authority MUST be distinguishable from normal delegated authority in traces and context provenance.
- Delegation grants SHOULD be temporary by default unless the operator explicitly marks them permanent.
- Apps, automations, chats, roles, contacts, and sessions MUST be represented as explicit subjects/objects when they carry authority.

## Canonical Formula

For a user-initiated turn:

```text
effective_caps =
  agent_caps
  INTERSECT (actor_caps OR actor_overrides)
  INTERSECT (surface_constraints OR surface_overrides OR inherited_actor_caps_when_no_surface_decision)
  INTERSECT turn_caps
```

Where:

- `agent_caps` are the maximum technical capabilities of the executor.
- `actor_caps` are capabilities the current speaker can delegate.
- `surface_constraints` are explicit constraints from chat, thread, route, instance, project, or session policy.
- `turn_caps` are short-lived caps for this invocation, approval, or explicit user confirmation.
- `actor_overrides` come from explicit `delegate_<relation>` grants on the executor agent or current surface and apply only for resolved contacts.
- `surface_overrides` come only from explicit `delegate_<relation>` grants on the current surface.
- A surface with no explicit grant, `deny_<relation>`, or `constrain role:<id>` decision for the same capability inherits the actor branch. This keeps normal chats from requiring duplicate grants while preserving the actor and agent ceilings.
- `deny_<relation>` on the surface is an explicit veto and MUST win over actor inheritance, surface grants, delegation overrides, and broader wildcards that would include the denied capability.
- `constrain role:<id>` remains an explicit surface boundary. If a surface constraint exists, capabilities outside that constraint are denied unless a surface-level delegation override explicitly allows them.

Overrides are not union authority. They are narrow branch substitutions and the
agent and turn ceilings still win.

For internal execution:

```text
effective_caps = automation_caps INTERSECT agent_caps INTERSECT target_surface_caps
```

Internal execution MUST use an explicit `automation:<id>` or `system:<id>` principal. It MUST NOT silently inherit the last human speaker.

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
