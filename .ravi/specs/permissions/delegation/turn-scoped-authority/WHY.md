---
id: permissions/delegation/turn-scoped-authority
title: "Turn Scoped Authority - Why"
kind: feature
domain: permissions
capability: delegation
feature: turn-scoped-authority
status: draft
normative: true
---

# Why

## Decision

Ravi originally treated user-initiated tool authority as delegated authority
from the current actor and surface to the executor agent for one invocation.
That model is now legacy fallback/debug only.

The active decision is agent identity authority:

```text
agent_identity_caps INTERSECT turn_caps_when_present
```

The actor remains mandatory provenance and unknown actors still fail closed,
but a resolved contact does not need its own tool capability for the agent to
operate in a shared compartment.

## Why This Is Required

The old per-actor intersection answered "what can this person make this agent
do from this surface right now?" That was secure but operationally too hard:
normal group workflows required repeated grants for contact, chat, and agent,
and denials with `surfaceCapabilityCount=0` led agents to ask for noisy
surface grants.

The agent identity model answers "what can this agent identity do in this
compartment?" This matches team-agent operation: operators configure the
agent's own authority for a channel/workspace/automation compartment, and
members of that compartment invoke that agent without duplicating every tool
grant onto themselves.

This still rejects ambient root-agent authority. The authority is short-lived,
compartment-scoped, and audit carries the actor/surface provenance.

Without turn-scoped agent identity, a powerful long-lived agent root context can
still leak tools across chats, sessions, automations, or stale actors.

## Why Roles

Roles match the operational model operators already understand:

- default blocked;
- explicit unlock;
- reusable bundles;
- scoped assignment;
- easy audit of who has what;
- clear blast radius when a role changes.

Role/profile modeling keeps authorization understandable. In the active model,
profiles should primarily attach to the agent identity/executor agent. Contact
and chat profile membership is reserved for invocation overlays, constraints,
or legacy delegated fallback.

## Alternatives Rejected

### Ambient agent-only permissions

Rejected when implemented as a long-lived root context. Accepted when projected
through `agent_identity:<agent>:<compartment>` into a short-lived turn context
with actor/surface provenance.

### Session-only permissions

Rejected because group sessions have multiple human actors. A trusted speaker and an untrusted speaker can share the same session.

### Chat-only permissions

Rejected because a chat is a surface, not a human. Chat policy can constrain authority but cannot prove who is speaking.

### Contact policy status as authorization

Rejected because `allowed`, `pending`, `blocked`, and `discovered` are intake/reply states. They do not express tool, executable, session, CLI, or CRM authority.

### Model self-enforcement

Rejected because the model can misunderstand prompt context, be prompt-injected, or lose track during long sessions. Host services and hooks must enforce.

### Union of agent and actor capabilities

Rejected for the legacy delegated fallback because union grants privilege
escalation. The active model does not union actor and agent capabilities; it
uses the agent identity only, with future user-level overlays modeled
explicitly.

### Live superadmin bypass for every context

Rejected for user-initiated invocation contexts because it makes agent admin power ambient. Break-glass must be explicit and traceable.

## Tradeoffs

- More context computation per turn is acceptable because it preserves
  compartment-scoped audit and freshness.
- Short-lived invocation contexts require more context records or refresh logic, but they make revocation and auditing reliable.
- Agent identity reduces configuration friction but moves responsibility to
  carefully scoped agent profiles and compartment policy.
