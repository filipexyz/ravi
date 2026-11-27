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
- `ravi agents set <id> defaults <json>` MUST apply the JSON as a patch: keys
  absent from it are kept and a key set to `null` is removed. The read of the
  current row, the merge and the write MUST happen in one IMMEDIATE write
  transaction, so a concurrent writer in another process cannot lose an
  update. Writers that build a whole defaults object from an earlier read
  (`agents permissions`, `agents model-broker`, a Library profile, the
  capability provider) MUST land only what they changed, applied over the
  stored row in one transaction (`dbRebaseAgentDefaults`). The merge is deep:
  when nobody else wrote, the writer's value stands as built; otherwise objects
  merge key by key at any depth and arrays merge as sets (added elements
  appended, removed elements dropped). `runtimePermissions.capabilities`
  entries are compared by canonical identity (`permission:objectType:objectId`
  string and object forms are the same capability), so a revocation applies
  whatever format another writer stored. Two writers that touch
  different entries of the same top-level key (two capabilities granted
  concurrently) both land. The break-glass check of that write MUST judge the
  transition from the row as stored inside the transaction, not the copy the
  caller read earlier (the `dbUpdateAgent` sink guard runs inside it).
  `agents set defaults` MUST refuse any change to `runtimePermissions`; only
  `ravi agents permissions <id>` writes it, for agents and the operator alike.
- Every write to `agents` that changes something MUST leave one `audit_log` row
  (`agent.updated`) with the caller and the changed fields/defaults keys, and
  only the old value of changed or removed keys in `detail.previous` (named
  `previousDefaults`, holding the whole object, before #1057), with
  secret-looking key names redacted at any depth; never the whole previous
  object. The audit write fails open: a
  failure is logged as a warning and the agent write still lands, because the
  audit exists to say who wrote, not to gate writes.
- A client that edits part of an agent's defaults MUST send only the keys it
  edits (a patch), never a copy of the rest of the object: a copied value would
  replay over a concurrent edit. It MUST NOT locate the agent through a
  paginated list (27/11: the WhatsApp overlay missed `main` in a paginated list
  and erased its defaults) and MUST NOT write when the agent cannot be read by id.
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
agent:<viewer> view agent:<target-agent>      # also read visibility into the agent's cron jobs/triggers
agent:<operator> modify agent:<target-agent>  # write boundary for the agent's owned runtime resources
agent:<operator> admin system:*               # break-glass/admin
```

`modify agent:<id>` currently authorizes mutating the cron jobs and triggers
owned by that agent (see `permissions/resource-visibility`). It does not yet
authorize changing the agent's own configuration.

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
(`agents list/show`) exposes `effectiveProvider`, `providerSource`,
`effectiveModel`, `modelSource` (`agent_preset` | `agent_default` |
`global_default` | `env_fallback` | `runtime_default`), `modelPresetId`,
`modelPresetVersion`, and `modelError`, resolved through the canonical
`resolveEffectiveAgentModel` / `resolveRequestedRuntimeProvider`. See
`runtime/model-presets` and `runtime/defaults`.

Provider and model are validated against each other, so a runtime switch has to
be one write. `agents set <id> provider <p> --model <m>` validates the pair
together and replaces both in one update; like any direct `model` write it also
drops a referenced preset instead of keeping a reference the new provider could
not run. `agents set <id> model clear` removes the direct `model` without
validating it. With `--force`, the paired write also clears session model
overrides, because the agent's model default changed with the provider.
