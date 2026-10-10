---
id: permissions/agent-identity
title: "Agent Identity Authority"
kind: capability
domain: permissions
capability: agent-identity
capabilities:
  - provider-runtime
  - runtime-context
  - agent-default-capabilities
  - audit
  - compartments
tags:
  - permissions
  - agent-identity
  - provider-runtime
  - runtime
applies_to:
  - src/permissions/agent-identity-permissions-provider.ts
  - src/permissions/contact-policy-permissions-provider.ts
  - src/permissions/provider-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/cli/commands/permissions.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Agent Identity Authority

## Intent

Ravi's active multiplayer authorization model is agent identity.

For external shared-surface turns, the primary question is:

```text
what can this agent identity do in this compartment?
```

It is not:

```text
what can this contact/user personally do?
```

This follows the team-agent model where the agent acts as itself under an
admin-managed identity, with authority scoped to a compartment such as a chat,
DM, automation, or workspace baseline.

## Active Runtime Contract

- Turn runtime MUST materialize `agent_identity:<agent-id>:<compartment-type>:<compartment-id>`.
- `agent-identity-permissions` MUST derive that identity from the executor
  agent's provider-owned runtime capabilities.
- Contact/user identity is invocation provenance and audit context by default.
  It MUST NOT be a required tool authority branch for shared-surface execution.
- Chat/surface identity selects the compartment by default. A chat with no
  policy MUST NOT zero the agent's authority.
- Unknown or unresolved actors MUST fail closed before agent identity
  capabilities are materialized for an external user-initiated turn.
- Runtime approval MUST NOT reopen that gate: a capability missing in a turn
  whose actor is unresolved (`actorResolution=missing_contact`) is denied
  without sending an approval request, because the request would go back to
  the unidentified actor's own surface.
- Turn approval/observer grants remain an upper bound when present.
- `contact-policy-permissions` is not the default runtime authority path. It
  participates only as the chat-scoped user overlay in governed chats
  (`permissions/user-overlay`), always intersected with the agent identity.

Current effective capability shape:

```text
effective_capabilities =
  agent_identity_capabilities
  INTERSECT contact_chat_capabilities_when_chat_is_governed
  INTERSECT turn_capabilities_when_present
```

A chat is governed when at least one chat or chat-tag contact grant covers it.
Ungoverned chats keep `agent_identity ∩ turn_caps` unchanged.

## Compartments

Current compartment ids:

- `chat:<canonical-chat-id>` for group/shared chat turns.
- `dm:<canonical-chat-id>` for direct-message turns when modeled as Ravi
  runtime compartments.
- `automation:<automation-id>` for cron/trigger/followup turns without a chat.
- `workspace:default` only when no narrower compartment exists.

The context metadata MUST include:

- `authorityMode=agent-identity`
- `authorityResolver=agent-identity-v1`
- `executorAgentId`
- `actorPrincipal` and `actorResolution`
- `surfacePrincipal` when available
- `agentIdentityPrincipal`
- `agentIdentityCompartment`
- `agentIdentityCapabilityCount`
- `effectiveCapabilityCount`
- `actorAuthorizationMode` (`invoke-only`, `not-applicable`, or
  `user-overlay`)
- `userOverlay`, `userOverlayChat`, `userOverlayThreadChat`, and
  `userOverlayGrants` when the actor is a contact on a chat surface

## Operator UX

Recurring access SHOULD be granted to the agent identity by updating the
executor agent's provider-owned runtime profile:

```bash
ravi permissions resolve <denial-id>
ravi permissions allow <profile> --to agent:<agent-id> --capabilities <permission>:<objectType>:<objectId>
```

For denials recorded with `authorityMode=agent-identity`, `resolve` MUST infer
`agent:<executorAgentId>` as the recurring target. When the denial also has
`actorAuthorizationMode=user-overlay`, `resolve` MUST plan a chat-scoped grant
for `contact:<actorId>` in the denied chat plus the executor agent ceiling.

Contact grants are chat-scoped (`--chat`, `--chat-tag`) or explicitly global
(`--force`). They only narrow what the agent does for that contact; they are
not a way to raise the agent ceiling.

## Retired Delegated Model

The previous `agent ∩ actor ∩ surface ∩ turn` delegated model MUST NOT be
reachable through runtime context creation.

Specs and skills MUST NOT present the delegated intersection as the production
default. The only actor branch in the active runtime path is the chat-scoped
user overlay (`permissions/user-overlay`); any other reintroduction of
actor/surface branches MUST be deliberate, tested, and documented.

## Acceptance Criteria

- In an ungoverned chat, a resolved contact can invoke capabilities held by the
  agent identity even when the contact has zero materialized capabilities.
- In a governed chat, a contact receives `agent_identity ∩ contact_chat_caps`,
  and a contact without a covering grant receives zero tool capabilities.
- A chat with zero materialized capabilities does not zero the agent identity.
- An unresolved external actor receives zero effective capabilities.
- An unresolved external actor's missing capability is denied without an
  approval request, even when someone on that surface could grant it.
- A denial from an agent-identity turn resolves to `--to agent:<executor>`.
- `agent-identity-permissions` appears in the default materializer chain.
