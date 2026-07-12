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
  - ravi-dev
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
- Agents MAY define runtime defaults such as `model`, `provider`, and `effort`.
  `effort` MUST use the canonical runtime effort set
  `none|minimal|low|medium|high|xhigh|max|ultra`.
- Agent `effort` is a fallback default for sessions without
  `session.effortOverride` and for task/profile gaps; it MUST NOT override
  task, dispatch, or profile runtime settings.
- Agent grants are a ceiling for what the executor can possibly do.
- Agent grants MUST NOT become ambient authority for every contact or chat that
  can speak to the agent.
- An agent MAY see itself.
- Viewing another agent MUST require `view agent:<target-agent>` unless the
  command is direct local operator CLI with no resolved principal.
- Agent list/show/picker/route-selection surfaces MUST filter by agent
  visibility.
- Every successful `ravi agents set` response MUST include `sessionOverrides`
  for all sessions owned by the agent that have active runtime overrides. Each
  entry MUST use the canonical session name and expose only active `model`,
  `effort`, and `thinking` fields. Human output MUST warn concisely when the
  array is non-empty and MUST NOT present raw channel ids as session identity.
- Idempotent `ravi agents set` mutations MAY return `changed=false`, but MUST
  still report the current `sessionOverrides` state.
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
- `ravi agents set <id> effort <level>` persists a canonical effort default,
  and `clear` removes it.
- `ravi agents set <id> <key> <value> --json` returns every active session
  runtime override using canonical session names, including on idempotent
  `changed=false` mutations.
- A superadmin executor invoked by an untrusted contact does not expose hidden
  agents solely because the executor has broad grants.

## Model Presets

Agents MAY reference a runtime model preset via `agents.model_preset_id` instead
of a direct `model`. The two are mutually exclusive on every create/update/set
path: assigning `modelPreset` clears the direct `model`, and writing a direct
`model` clears `modelPresetId`, both in one transaction. Provider writes fail
with an actionable error when incompatible with a referenced preset. Agent JSON
(`agents list/show`) exposes `effectiveProvider`, `effectiveModel`,
`modelSource` (`agent_preset` | `agent_default` | `global_default`),
`modelPresetId`, and `modelPresetVersion`, resolved through the canonical
`resolveEffectiveAgentModel`. See `runtime/model-presets`.
