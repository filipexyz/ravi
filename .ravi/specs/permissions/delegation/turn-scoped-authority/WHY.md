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

Ravi will treat user-initiated tool authority as delegated authority from the current actor and surface to the executor agent for one invocation.

The effective capability set is an intersection:

```text
agent_caps INTERSECT actor_caps INTERSECT surface_caps INTERSECT turn_caps
```

## Why This Is Required

The existing agent-centric model answers "what can this agent do?".

The security question for a multi-user channel is different: "what can this person make this agent do from this surface right now?"

Without turn-scoped delegation, a powerful agent in a WhatsApp group, Discord channel, Telegram DM, Slack thread, task observer, or cron-driven workflow can expose privileged tools to actors who were never authorized to operate those tools.

## Why Roles

Roles match the operational model operators already understand:

- default blocked;
- explicit unlock;
- reusable bundles;
- scoped assignment;
- easy audit of who has what;
- clear blast radius when a role changes.

Role/profile modeling keeps authorization understandable: roles are reusable capability bundles, and contacts/chats are explicit members or constraints.

## Alternatives Rejected

### Agent-only permissions

Rejected because an agent can serve many humans and chats. Agent-only permissions create ambient authority.

### Session-only permissions

Rejected because group sessions have multiple human actors. A trusted speaker and an untrusted speaker can share the same session.

### Chat-only permissions

Rejected because a chat is a surface, not a human. Chat policy can constrain authority but cannot prove who is speaking.

### Contact policy status as authorization

Rejected because `allowed`, `pending`, `blocked`, and `discovered` are intake/reply states. They do not express tool, executable, session, CLI, or CRM authority.

### Model self-enforcement

Rejected because the model can misunderstand prompt context, be prompt-injected, or lose track during long sessions. Host services and hooks must enforce.

### Union of agent and actor capabilities

Rejected because union grants privilege escalation: a powerful agent or powerful actor can fill the other's missing authority. Delegation requires both the executor and actor to authorize the capability.

### Live superadmin bypass for every context

Rejected for user-initiated invocation contexts because it makes agent admin power ambient. Break-glass must be explicit and traceable.

## Tradeoffs

- More context computation per turn is acceptable because it prevents cross-actor leakage.
- Short-lived invocation contexts require more context records or refresh logic, but they make revocation and auditing reliable.
- Intersection can deny more often at first. Denials are correct until roles/surface policies are explicitly configured.
