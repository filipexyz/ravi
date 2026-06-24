---
id: permissions/delegation/turn-scoped-authority
title: "Turn Scoped Authority"
kind: feature
domain: permissions
capability: delegation
feature: turn-scoped-authority
capabilities:
  - provider-runtime
  - runtime-context
  - agent-identity
  - contacts
  - chats
  - host-services
tags:
  - permissions
  - provider-runtime
  - delegation
  - contacts
  - runtime
  - tools
applies_to:
  - src/permissions/provider-runtime.ts
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
  - ravi-dev
status: active
normative: true
---

# Turn Scoped Authority

## Intent

Turn scoped authority gives every external/automation turn a short-lived
effective capability set with structured provenance.

Every external inbound turn MUST carry a structured invocation principal and a short-lived effective capability set. Tools, CLI commands, executable approval, session access, contact writes, SDK gateway streams, and child contexts MUST authorize against that invocation context.

The active production model is agent identity: the agent acts as itself under a
compartment-scoped identity. Contact/user identity proves who invoked the turn
and drives audit/invocation policy, but it is not a required tool-authority
branch by default.

The previous delegated model (`agent ∩ actor ∩ surface ∩ turn`) is retired from
runtime context creation and remains only as historical spec/test context.

## Definitions

- `invocation`: one prompt turn caused by an inbound message, CLI prompt, task, trigger, cron job, observer event, or system event.
- `actor_principal`: the principal that caused the invocation.
- `actor_context`: structured identity facts for the current actor, including `actor_type`, `contact_id`, `platform_identity_id`, `chat_id`, channel, instance/account, route, and provenance.
- `executor_agent`: the Ravi agent running the provider turn.
- `surface_context`: chat/thread/route/instance/project/session constraints around the invocation.
- `agent_identity`: compartment-scoped authority principal, formatted
  `agent_identity:<agent-id>:<compartment-type>:<compartment-id>`.
- `effective_capabilities`: materialized agent identity capabilities,
  intersected with turn caps when present.
- `ambient agent authority`: long-lived root agent context reused without a
  turn-scoped context. This remains forbidden for external turns.

## Required Actor Resolution

- Ravi MUST resolve the invocation actor before building the runtime context for every external inbound turn.
- For human inbound messages, actor resolution MUST start from persisted message metadata: `actor_type`, `contact_id`, `platform_identity_id`, `chat_id`, raw sender ids, channel, and instance/account.
- Display name, phone string, group title, or provider JID alone MUST NOT be sufficient actor authority.
- If the actor resolves to `contact:<id>`, that contact is the invoker/audit
  principal.
- If the actor resolves to `agent:<id>`, that agent is the delegator only for agent-originated internal handoffs. It MUST NOT be confused with the executor agent.
- If the actor is `unknown`, unresolved, blocked, opted out, or contradictory,
  the invocation MUST receive no agent identity tool/executable/CLI/session/contact authority.
- A group chat MUST NOT be treated as the actor. It selects or constrains the
  agent identity compartment.

## Effective Capability Contract

For external user-initiated invocations in the active model:

```text
effective_capabilities =
  intersect(
    resolveAgentIdentityCapabilities(executor_agent, compartment),
    resolveTurnApprovals(invocation)
  )
```

Rules:

- Agent identity projection is mandatory. Ambient root agent context is
  forbidden for external user-initiated tool authority.
- Missing capability set means empty set, not wildcard.
- Any explicit deny, block, opt-out, revoked context, disabled principal, or failed identity resolution MUST win over allow.
- `admin system:*` in the executor's runtime config MAY materialize into an
  agent identity only when that agent identity/profile explicitly has it.
- Contact/user `admin system:*` MUST NOT grant tool authority in agent-identity
  mode. Break-glass is a separate operator path.
- A surface with no provider-owned policy MUST NOT zero the agent identity.
- Surface/user overlays MAY reduce or require additional checks only when a
  future provider explicitly implements that overlay on top of agent identity.
- `contact_policies.status=allowed` permits interaction, not tools. It MUST NOT imply `use tool:*`, `execute executable:*`, `execute group:*`, session access, or contact writes.

Legacy delegated fallback formula:

```text
effective_capabilities =
  agent_caps
  INTERSECT (actor_caps OR actor_overrides)
  INTERSECT surface_caps
  INTERSECT turn_caps
```

This fallback MUST NOT be the production default.

## Runtime Context Requirements

User-initiated execution MUST use an invocation-scoped runtime context or equivalent turn-scoped capability overlay.

Turn-scoped authority MUST always be enabled for new dispatch. The historical
`RAVI_TURN_SCOPED_AUTHORITY` flag is retired and MUST NOT disable
agent-identity context creation.

The context MUST include:

- `context_kind`: distinguishable from long-lived agent root contexts, e.g. `invocation-runtime` or `turn-runtime`.
- `executor_agent_id`
- `actor_principal_type`
- `actor_principal_id`
- `agent_identity_principal`
- `agent_identity_compartment`
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

## Capability Freshness

Agent identity contexts snapshot provider-owned state at turn start. Snapshots
are audit artifacts, not a second source of truth:

- A grant created after a denial MUST take effect by the next turn of the
  affected session without daemon restart or manual context surgery.
- A revocation MUST stop authorizing by the next authority check (existing
  superadmin-boundary rule); the same freshness applies to role membership
  and constraint changes.
- Capability counts persisted in context metadata
  (`agentIdentityCapabilityCount`, `actorCapabilityCount`,
  `surfaceCapabilityCount`, ...) describe the moment the context was built.
  In agent-identity mode, `actorCapabilityCount=0` or `surfaceCapabilityCount=0`
  is not itself a denial reason.
- The long-term direction is to evaluate authority against the live graph at
  check time and keep per-turn snapshots only for audit provenance. Any
  caching layer MUST key on actor identity and an authority version, and a
  graph mutation MUST invalidate affected cache entries before the next
  check.

## No Cross-Actor Leakage

- Runtime contexts for user-initiated turns MUST NOT be keyed only by `agent_id + session_key`.
- A reusable context cache MUST include actor identity, compartment, and
  authority version in its cache key, or it MUST refresh effective
  capabilities on every turn.
- In a multi-participant group, prompt/audit actor metadata MUST refresh when
  the speaker changes. Tool authority remains the agent identity for that
  compartment unless an explicit user-level overlay exists.
- A system interruption MAY preserve conversational floor for prompt readability, but it MUST NOT create new human authority.
- Conversation thread annotations are prompt comprehension only. Tools MUST use structured actor context.

## Superadmin Boundary

Live executor-agent administrator authority is valid only for internal admin contexts.

For user-initiated invocation contexts:

- `canWithCapabilityContext` MUST NOT bypass effective capabilities solely
  because the root executor agent is superadmin.
- Live grants MAY be considered only through the active agent identity
  materializer or explicit break-glass/operator path.
- Revoking a critical agent identity, turn, or future overlay policy MUST
  invalidate or refresh active invocation contexts before the next tool call.

## Tool And CLI Enforcement

All authority-bearing surfaces MUST authorize against the effective invocation context:

- SDK tool use: `use tool:<tool-name>`
- Tool groups: `use toolgroup:<group>`
- Bash command approval: `use tool:Bash` and `execute executable:<binary>`
- Ravi CLI admin groups: `execute group:<group>` or `execute group:<group>_<command>`
- App discovery and non-mutating app operation: `use app:<app-id>`
- Mutating app operation: `execute app:<app-id>`
- Session read/write: `access session:<id>` and `modify session:<id>`
- Contact/CRM reads: `read_contact contact:<id>`,
  `read_own_contacts system:*`, `read_tagged_contacts system:<tag>`, or a
  future explicit CRM object relation
- Contact/CRM writes: `write_contacts system:*` or narrower future contact/CRM
  scoped capabilities
- Gateway streams: `view/access <object>`
- Child context issuance: requested child capabilities MUST be a subset of effective parent capabilities

Providers that cannot route restricted tool permission through Ravi MUST reject restricted user-initiated invocations before provider start.

## Roles And Grants

The preferred production model is provider-owned agent identity profiles:

```text
agent:<agent-id> execute executable:curl
agent:<agent-id> mutate image:generate
agent_identity:<agent-id>:chat:<chat-id> materializes from agent:<agent-id>
```

Legacy human delegation role examples:

```text
contact:<id> member role:owner
contact:<id> member role:trusted-dev
role:owner admin system:*
role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
chat:<id> constrain role:group-safe
role:group-safe use toolgroup:read-only
```

Role/profile expansion MUST be deterministic and auditable. In the active
model, expansion feeds agent identity materialization unless a documented
overlay provider says otherwise.

## Explicit Delegation Overrides

Some operations are intentionally allowed in a specific agent or chat even when
the current contact does not have the corresponding capability directly. This
MUST use an explicit override relation:

```text
agent:<agent-id> delegate_use tool:Bash
chat:<chat-id> delegate_use tool:Bash
chat:<chat-id> delegate_execute group:apps_run
```

Rules:

- Delegation overrides are legacy fallback semantics and MUST NOT be presented
  as the normal agent-identity operator workflow.
- `delegate_<relation>` is not a normal capability and MUST NOT appear in
  `actor_caps`, `surface_caps`, or `effective_capabilities`.
- The override maps only to the underlying relation during delegated context
  construction, e.g. `delegate_use tool:Bash` can satisfy `use tool:Bash`.
- Agent-level overrides satisfy the actor branch only. The surface still needs
  a normal surface grant or a surface override.
- Surface-level overrides satisfy both the actor branch and the surface branch
  for that surface.
- Overrides apply only when the actor resolved to a concrete contact. Unknown
  actors and automation principals MUST NOT receive human delegation overrides.
- The executor agent MUST still have the requested capability through normal
  grants. `delegate_use tool:Bash` cannot make an agent without `use tool:Bash`
  run Bash.
- `delegate_admin` MUST be rejected or ignored. Superadmin delegation requires
  the separate break-glass/admin-delegated path.
- Turn/observer approval grants remain an upper bound and MUST NOT be overridden.
- Runtime metadata and denial audit MUST expose override counts and the
  principals that supplied overrides.

## Automation And Observer Boundary

- Cron, trigger, observer, workflow, and daemon events MUST run as explicit `automation:<id>` or `system:<id>` principals.
- Automation MUST NOT inherit the last human actor in the session.
- Cron prompts MUST resolve as `automation:cron:<job-id>`.
- Trigger prompts MUST resolve as `automation:trigger:<trigger-id>`.
- Automation prompts run under an automation or chat-scoped agent identity.
  They MUST NOT inherit the last human actor in the session.
- Automation prompts without a chat/source MAY omit the surface constraint; if
  they target or reply into a chat, that chat MAY further constrain authority.
- Observer permission grants apply to the observer runtime context only. They MUST NOT grant tools to the source session or source actor.
- If automation posts into a human chat, its outbound delivery authority is separate from tool authority.

## Prompt Contract

The prompt envelope SHOULD carry `active_actor_context` for model comprehension, but the host permission layer MUST receive the same facts out of band.

The model MUST NOT be trusted to self-enforce per-user authority. The host layer owns enforcement.

## Acceptance Criteria

- A resolved contact in a chat can invoke capabilities held by the
  compartment's agent identity even when the contact has zero materialized
  capabilities.
- An unresolved sender receives a textual response path only; authority-bearing
  tools deny with an explainable reason.
- A chat with zero materialized capabilities does not zero the agent identity.
- A cron job runs under automation provenance and an automation/chat-scoped
  agent identity; it does not inherit the last speaker.
- Runtime traces can explain the allow/deny decision in terms of agent
  identity, executor agent, actor provenance, compartment, turn caps, and
  context id.
