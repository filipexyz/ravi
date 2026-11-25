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
Ungoverned chats keep `agent_identity ∩ turn_caps`, with one exception:

- Break-glass never reaches a person through the agent ("full-access minus
  break-glass" for the actor). When the actor of a turn is a contact and the
  chat is ungoverned, the turn keeps everything of the agent identity, including
  what the `admin:system:*` shortcut grants (images, web, tools), but carries a
  `deny_<permission>` entry for each break-glass power the agent holds and the
  contact does not: `admin:system:*` and `execute:executable:*`. The snapshot
  matcher honors `deny_*` before the admin shortcut and wildcards (an explicit,
  non-wildcard capability for the exact object still allows it), and the Bash
  PreToolUse hook honors it before the live executor ceiling, so the person gets
  neither system admin nor arbitrary commands. The contact's own capabilities
  count in full; turns with no contact actor (cron, trigger, agent-to-agent)
  are unchanged. The withheld list is recorded as `actorBreakGlassWithheld`.
- A denial born from that rule resolves to a chat-scoped grant for the contact
  (`permissions resolve`), not to the executor agent.
- The limit follows derived turns. A turn relayed from that person's turn
  (inform, ask, execute, thread bootstrap) gets the caller's positive
  capabilities and re-applies the same `deny_*`; a deny is never passed as a
  positive narrowing (a deny of the admin shortcut would erase everything).
- Automation cannot outlive the limit: a turn carrying
  `actorBreakGlassWithheld` (or a relay of one) cannot write cron jobs,
  triggers, session followups, hooks, signals or tasks; the write is refused
  with `PERMISSION_DENIED` and the operator sets it up. The rule lives in the
  stores, not only in commands: `assertAutomationStoreWrite`
  (`permissions/user-overlay-automation.ts`) runs in `dbCreateTrigger`,
  `dbUpdateTrigger`, `dbCreateCronJob`, `dbUpdateCronJob`, `dbCreateHook`,
  `dbUpdateHook`, `createSessionFollowupCadence`,
  `updateSessionFollowupCadence`, `dbInsertSignal` and
  `dbCreateTaskAutomation`, so any writer (`watch trigger`, page comment
  follow, bug follow, or a new one) is refused from such a turn. Disabling is
  always allowed; code outside a turn is unaffected; an overlay turn may still
  write a cron job bound to its chat (`creatorChat`). Command guards remain
  for a good error. Binding the job to the creator's ceiling is deferred.
- A contact whose own power covers the agent in a governed chat (the operator
  with an admin tag) is not an overlay turn: the overlay is lifted
  (`permissions/user-overlay`, "Lifted Overlay"), so its automation is not
  held, a cron job it writes is unbound like one from an ungoverned chat, and
  the threads it opens are stamped by the rule below. The lift reads the
  contact's global permission tags, never a chat grant: full access granted
  in a chat keeps the turn an overlay turn and its automation refused. Before
  this (25/11), the operator speaking in a chat where someone else held a
  grant could not write automation, and every thread it opened was held.
- A relay the operator asked for (a thread the main session opens for a verified
  human request, a session relay of the operator's turn) is not a held turn.
  `relayNarrowing` only says the turn carries its caller's capabilities as a
  ceiling, for the lineage a revocation follows; it is set for every verified
  human work handoff, the operator's included. `resolveRelayCaller` stamps the
  relay `relayCallerUnrestricted` when its caller was none of: narrowed to a
  contact's chat grants, held below break-glass (`deny_*`), revoked, or itself a
  held relay, and its ceiling covers the target agent's own authority, by the core matcher and never by count (a plain
  contact relaying to a full-access agent is held: the relay would otherwise let
  automation run later as the worker's full authority). The automation guards (command and store) read
  `isRelayHeldBelowAgent` (`permissions/actor-limit.ts`), not the bare flag, so
  only a held relay is refused. A relay without the stamp (an older context, a
  chain through a held turn) stays held: the rule fails closed. Before this,
  every thread of the operator lost the CI follow of `ravi pr publish` (24/11,
  3.261124.15) and `triggers add`/`cron add`/follow-ups from it were refused.
- The refusal names its cause, because the remedy differs
  (`automationHoldCause`, `permissions/user-overlay-automation.ts`; causes and
  advice in `permissions/automation-hold.ts`): a relayed turn whose caller does
  not carry the agent's whole authority (named first, also when the turn is
  narrowed to a contact's grants too, as a thread opened from a governed chat), a
  turn narrowed to a contact's chat grants, or a person with no grant in the
  chat. No advice points at a grant: a held relay says requesting access for a
  contact does not lift it; an overlay turn says more chat permissions do not;
  approving full access for a person without a grant only makes their next turn
  an overlay turn, still refused. The cause travels as the `automationHold`
  control field (command, store and the `pr publish` follow refusal), and the
  remote CLI maps it to the same fixed advice instead of the generic "request
  the permission", never forwarding server text. On 24/11 a relay refused with
  "limited to a contact's chat permissions" and the generic remote advice led the
  main session to request full access for the operator, who already held it.
- What "everything except break-glass" still includes (declared): the admin
  shortcut still grants every other `(permission, objectType)`, e.g.
  `execute:group:*` CLI groups, `write_contacts:system:*` and `admin` on types
  other than `system`. Only `admin:system:*` and `execute:executable:*` are
  withheld.
- Executables the core spawns from a name that came from a command or a
  manifest (app commands: `apps import-cli`, `apps run`, app permission
  providers) go through `assertTurnMayExecute`
  (`permissions/turn-executable.ts`): a turn that withholds
  `execute:executable:*` cannot spawn anything but Ravi itself. Observer rules
  and task automation updates are guarded at the store too; pausing a session
  followup stays allowed, re-enabling it is guarded.
- File writes for that person are an allowlist: the session workspace and
  the temp directory, symlinks resolved; the workspace never counts when it is
  the filesystem root or the home directory. Operator config the daemon turns
  into code at boot (`~/.ravi/.env`, the installed bundle, shell rc, launch
  agents) is refused without `execute:executable:*` or `admin:system:*`
  (`providerConfigWriteDenial` with `restrictToWorkspace`).
- The workspace is configuration an agent can change, so it is not the only
  boundary: the Ravi state dir, `~/.bun`, launch agents, systemd and fish
  config and shell startup files are always refused for the limited person,
  and moving an agent's `cwd` or creating an agent is refused in a limited
  turn (`dbUpdateAgent`, `dbCreateAgent`).
- The limit is read from the capabilities as well as the metadata
  (`isActorBreakGlassLimitedContext`), so derived contexts that inherit the
  `deny_*` keep every guard.
- Known residual risk: inside the workspace, file tools stay open, so a
  person without grants can edit files in the agent's workspace (AGENTS.md, MEMORY.md, skills) that later autonomous turns
  read as instructions. Follow-up of design, not closed here.
- Consequence: revoking the last grant of a chat can never widen a participant
  to the agent's break-glass.

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
