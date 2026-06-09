---
id: agents
title: Agents
kind: domain
domain: agents
capabilities:
  - visibility
  - routing
  - permissions
tags:
  - agents
  - permissions
  - sessions
  - routes
applies_to:
  - src/cli/commands/agents.ts
  - src/permissions/scope.ts
  - src/router
  - src/runtime
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Agents

## Intent

Agents are Ravi execution identities. They define behavior, working directory,
provider configuration, and technical authority ceilings.

An agent is not a human user, contact, chat, route, or permission profile.

## Invariants

- Every runtime session MUST belong to exactly one agent.
- Agent grants are a ceiling for what the executor can possibly do.
- Agent grants MUST NOT become ambient authority for every contact or chat that
  can speak to the agent.
- An agent MAY see itself.
- Viewing another agent MUST require `view agent:<target-agent>` unless the
  command is direct local operator CLI with no resolved principal.
- Agent list/show/picker/route-selection surfaces MUST filter by agent
  visibility.
- Hidden agents SHOULD appear missing on direct lookup.
- Routes that point to hidden agents MUST NOT disclose hidden agent metadata to
  principals that lack `view agent:<id>`.

## Canonical Relations

```text
agent:<viewer> view agent:<target-agent>
agent:<operator> modify agent:<target-agent>  # future/narrower write boundary
agent:<operator> admin system:*               # break-glass/admin
```

`admin system:*` MAY remain a break-glass operator capability, but delegated
user-initiated contexts MUST still intersect actor and surface authority before
tool execution.

## Acceptance Criteria

- `agents list --json` under runtime context includes the current agent and
  agents covered by `view agent:<id>`, and excludes others.
- `agents show <hidden-agent> --json` does not reveal hidden agent
  configuration.
- Agent route inspection does not disclose hidden agent config to a principal
  that lacks `view agent:<id>`.
- A superadmin executor invoked by an untrusted contact does not expose hidden
  agents solely because the executor has broad grants.
