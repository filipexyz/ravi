---
id: permissions/delegation/turn-scoped-authority
title: "Turn Scoped Authority"
kind: feature
domain: permissions
capability: delegation
feature: turn-scoped-authority
capabilities:
  - rebac
  - runtime-context
  - contacts
  - chats
  - host-services
tags:
  - permissions
  - rebac
  - delegation
  - contacts
  - runtime
  - tools
applies_to:
  - src/permissions/engine.ts
  - src/permissions/capability-context.ts
  - src/permissions/scope.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/context-registry.ts
  - src/runtime/host-services.ts
  - src/runtime/host-hooks.ts
  - src/omni/consumer.ts
  - src/contacts.ts
  - src/router/router-db.ts
owners:
  - ravi-rebac
  - ravi-dev
status: draft
normative: true
---

# Turn Scoped Authority

## Intent

Turn scoped authority prevents a powerful agent from exposing its full toolset to every person who can message it.

Every external inbound turn MUST carry a structured invocation principal and a short-lived effective capability set. Tools, CLI commands, executable approval, session access, contact writes, SDK gateway streams, and child contexts MUST authorize against that invocation context.

Agent grants define what the executor can possibly do. They do not define what this actor is allowed to make the executor do.

## Definitions

- `invocation`: one prompt turn caused by an inbound message, CLI prompt, task, trigger, cron job, observer event, or system event.
- `actor_principal`: the principal that caused the invocation.
- `actor_context`: structured identity facts for the current actor, including `actor_type`, `contact_id`, `platform_identity_id`, `chat_id`, channel, instance/account, route, and provenance.
- `executor_agent`: the Ravi agent running the provider turn.
- `surface_context`: chat/thread/route/instance/project/session constraints around the invocation.
- `effective_capabilities`: intersection result used for the invocation.
- `ambient agent authority`: any decision that allows a tool because the agent has a grant, without checking the actor/surface for user-initiated execution.

## Required Actor Resolution

- Ravi MUST resolve the invocation actor before building the runtime context for every external inbound turn.
- For human inbound messages, actor resolution MUST start from persisted message metadata: `actor_type`, `contact_id`, `platform_identity_id`, `chat_id`, raw sender ids, channel, and instance/account.
- Display name, phone string, group title, or provider JID alone MUST NOT be sufficient actor authority.
- If the actor resolves to `contact:<id>`, that contact is the delegator.
- If the actor resolves to `agent:<id>`, that agent is the delegator only for agent-originated internal handoffs. It MUST NOT be confused with the executor agent.
- If the actor is `unknown`, unresolved, blocked, opted out, or contradictory, the invocation MUST receive no delegated tool/executable/CLI/session/contact authority.
- A group chat MUST NOT be treated as the actor. It is a surface constraint.

## Effective Capability Contract

For external user-initiated invocations:

```text
effective_capabilities =
  intersect(
    resolveAgentCapabilities(executor_agent),
    resolveActorCapabilities(actor_principal, actor_context),
    resolveSurfaceCapabilities(surface_context),
    resolveTurnApprovals(invocation)
  )
```

Rules:

- Intersection is mandatory. Union is forbidden for user-initiated tool authority.
- Missing capability set means empty set, not wildcard.
- Any explicit deny, block, opt-out, revoked context, disabled principal, or failed identity resolution MUST win over allow.
- `admin system:*` in `agent_caps` MUST NOT by itself allow a user-initiated invocation.
- `admin system:*` in `actor_caps` MAY allow break-glass authority only when the actor is an approved owner/operator principal and the invocation trace marks the mode as break-glass or admin-delegated.
- Surface policy MAY reduce capabilities. It MUST NOT grant a capability absent from both actor and agent ceilings.
- `contact_policies.status=allowed` permits interaction, not tools. It MUST NOT imply `use tool:*`, `execute executable:*`, `execute group:*`, session access, or contact writes.

## Runtime Context Requirements

User-initiated execution MUST use an invocation-scoped runtime context or equivalent turn-scoped capability overlay.

The context MUST include:

- `context_kind`: distinguishable from long-lived agent root contexts, e.g. `invocation-runtime` or `turn-runtime`.
- `executor_agent_id`
- `actor_principal_type`
- `actor_principal_id`
- `contact_id` when resolved
- `platform_identity_id` when resolved
- `chat_id`
- `session_key`
- `source_channel`
- `source_account_id` or instance id
- `route_pattern` when available
- `capabilities`
- `capability_provenance`
- `created_at`, `expires_at`, `revoked_at`

The context MUST be short-lived. A user-initiated invocation context SHOULD expire in minutes, not days. Child contexts MUST expire no later than their parent.

## No Cross-Actor Leakage

- Runtime contexts for user-initiated turns MUST NOT be keyed only by `agent_id + session_key`.
- A reusable context cache MUST include actor identity and authority version in its cache key, or it MUST refresh effective capabilities on every turn.
- In a multi-participant group, a trusted speaker's capabilities MUST NOT remain available when the next speaker is untrusted.
- A system interruption MAY preserve conversational floor for prompt readability, but it MUST NOT create new human authority.
- Conversation thread annotations are prompt comprehension only. Tools MUST use structured actor context.

## Superadmin Boundary

Existing engine behavior that lets live `isAgentSuperadmin(agentId)` win is valid only for internal admin contexts.

For user-initiated invocation contexts:

- `canWithCapabilityContext` MUST NOT bypass effective capabilities solely because `executor_agent_id` is superadmin.
- Live grants MAY be considered only if they are intersected with current actor and surface authority.
- Revoking a critical actor, role, chat, or agent grant MUST invalidate or refresh active invocation contexts before the next tool call.

## Tool And CLI Enforcement

All authority-bearing surfaces MUST authorize against the effective invocation context:

- SDK tool use: `use tool:<tool-name>`
- Tool groups: `use toolgroup:<group>`
- Bash command approval: `use tool:Bash` and `execute executable:<binary>`
- Ravi CLI admin groups: `execute group:<group>` or `execute group:<group>_<command>`
- Session read/write: `access session:<id>` and `modify session:<id>`
- Contact/CRM writes: `write_contacts system:*` or narrower future contact-scoped relations
- Gateway streams: `view/access <object>`
- Child context issuance: requested child capabilities MUST be a subset of effective parent capabilities

Providers that cannot route restricted tool permission through Ravi MUST reject restricted user-initiated invocations before provider start.

## Roles And Grants

The preferred model for human delegation is role-based allow lists:

```text
contact:<id> member role:owner
contact:<id> member role:trusted-dev
role:owner admin system:*
role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
chat:<id> constrain role:group-safe
role:group-safe use toolgroup:read-only
```

Role expansion MUST be deterministic and auditable. If two roles disagree, the more restrictive result wins after intersection with surface policy.

## Automation And Observer Boundary

- Cron, trigger, observer, workflow, and daemon events MUST run as explicit `automation:<id>` or `system:<id>` principals.
- Automation MUST NOT inherit the last human actor in the session.
- Observer permission grants apply to the observer runtime context only. They MUST NOT grant tools to the source session or source actor.
- If automation posts into a human chat, its outbound delivery authority is separate from tool authority.

## Prompt Contract

The prompt envelope SHOULD carry `active_actor_context` for model comprehension, but the host permission layer MUST receive the same facts out of band.

The model MUST NOT be trusted to self-enforce per-user authority. The host layer owns enforcement.

## Acceptance Criteria

- A superadmin agent invoked by an untrusted contact cannot use Bash, CLI admin commands, session access, or contact writes unless that contact and surface also authorize them.
- In the same group session, a trusted contact can invoke an allowed tool and the next untrusted contact is denied without resetting the session.
- An unresolved sender receives a textual response path only; authority-bearing tools deny with an explainable reason.
- A chat-level constraint can reduce an owner's power in a public group.
- A cron job runs under its automation principal and does not inherit the last speaker.
- Runtime traces can explain the allow/deny decision in terms of agent, actor, surface, turn, roles, and context id.

