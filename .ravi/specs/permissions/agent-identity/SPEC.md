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
- Turn approval/observer grants remain an upper bound when present.
- Direct `contact-policy-permissions` materialization is legacy/user-overlay
  support. It MUST NOT be the default runtime authority path for multiplayer
  agent execution.

Current effective capability shape:

```text
effective_capabilities =
  agent_identity_capabilities
  INTERSECT turn_capabilities_when_present
```

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

## Operator UX

Recurring access SHOULD be granted to the agent identity by updating the
executor agent's provider-owned runtime profile:

```bash
ravi permissions resolve <denial-id>
ravi permissions allow <profile> --to agent:<agent-id> --capabilities <permission>:<objectType>:<objectId>
```

For denials recorded with `authorityMode=agent-identity`, `resolve` MUST infer
`agent:<executorAgentId>` as the recurring target. It SHOULD NOT attach contact
policy tags unless the denial came from an explicit legacy/user-overlay path.

Contact tags MAY still be used for future invocation eligibility or
user-overlay policy, but they are not the normal way to unblock tool authority.

## Retired Delegated Model

The previous `agent ∩ actor ∩ surface ∩ turn` delegated model MUST NOT be
reachable through runtime context creation.

Specs and skills MUST NOT present the delegated intersection as the production
default. Any reintroduction of actor/surface branches into the active runtime
path MUST be deliberate, tested, and documented as a user-level overlay on top
of agent identity.

## Acceptance Criteria

- A resolved contact in a chat can invoke capabilities held by the agent
  identity even when the contact has zero materialized capabilities.
- A chat with zero materialized capabilities does not zero the agent identity.
- An unresolved external actor receives zero effective capabilities.
- A denial from an agent-identity turn resolves to `--to agent:<executor>`.
- `agent-identity-permissions` appears in the default materializer chain.
