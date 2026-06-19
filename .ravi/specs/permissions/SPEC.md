---
id: permissions
title: "Permissions"
kind: domain
domain: permissions
capabilities:
  - provider-runtime
  - cli-command-access
  - delegation
  - resource-visibility
  - profiles
  - tag-policy
  - runtime-context
  - least-privilege
  - explain
  - production-readiness
  - enterprise
tags:
  - permissions
  - provider-runtime
  - runtime
  - security
applies_to:
  - src/permissions
  - src/runtime
  - src/tags
  - src/tag-rules
  - src/contacts.ts
  - src/omni/consumer.ts
  - src/router/router-db.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permissions

## Intent

Ravi permissions define who can cause Ravi to read, execute, mutate, deliver, or
disclose state.

The Permission Provider Runtime is the only authorization surface for Ravi
core. Ravi core MUST NOT embed a native permission graph as policy.

## Active Chain

Authorization providers:

- `local-operator`
- `context-capabilities`

Capability materializers:

- `runtime-bootstrap`
- `agent-runtime-permissions`
- `contact-policy-permissions`

The command surface for permissions is inspection-only:

```bash
ravi permissions status
ravi permissions check --permission <perm> --object-type <type> --object-id <id>
ravi permissions materialize --subject-type <type> --subject-id <id>
```

Authority mutation for agents MUST use provider-owned configuration:

```bash
ravi agents permissions <agent-id> <profile>
ravi agents permissions <agent-id> bootstrap --capabilities <perm>:<type>:<id>
```

## Invariants

- Ravi MUST fail closed when the effective principal, action, object, or context
  cannot be resolved.
- Permission checks MUST use canonical Ravi subjects and objects, not raw
  provider ids, display names, phone numbers, or chat titles.
- Contacts, agents, chats, sessions, automations, observers, roles, and system
  actors are distinct principals.
- An executor agent is a technical ceiling, not sufficient authority for a
  user-initiated external turn.
- External user-initiated execution MUST be authorized by executor agent, actor,
  surface, and turn capabilities.
- Groups/chats/threads are communication surfaces. They MAY constrain or
  explicitly override specific delegated branches, but they MUST NOT replace
  the current actor principal.
- `contact_policies` status controls intake/reply eligibility. It MUST NOT be
  treated as tool, executable, CLI, session, contact, app, or gateway authority.
- Tags are selectors and metadata. Tags MUST NOT grant authority unless a
  configured provider explicitly consumes the permission-scoped tag.
- Runtime contexts MUST carry structured authority provenance for audit and
  denial diagnosis.
- Runtime providers MUST request authorization through the Permission Provider
  Runtime and MUST NOT read unrelated provider storage directly.
- Discovery is disclosure. List, show, search, check, autocomplete, alias
  resolution, SDK discovery, and UI picker surfaces MUST filter to resources
  visible to the effective context.

## Subject Types

- `agent`: Ravi agent identity and maximum technical authority.
- `contact`: canonical human or organization from `chat.db.contacts`.
- `platform_identity`: channel-specific identity linked to a contact or agent.
- `chat`: canonical communication surface from `ravi.db.chats`.
- `session`: runtime session.
- `role`: reusable authority bundle.
- `automation`: cron, trigger, observer, workflow, or daemon-originated actor.
- `system`: break-glass or platform-owned actor.

## Resource Visibility

Resources MUST be isolated by default.

Canonical visibility capabilities:

- `view agent:<id>` for agent discovery beyond self.
- `access session:<id>` for session read/trace/list visibility beyond own
  session.
- `modify session:<id>` for session mutation beyond own session.
- `use app:<id>` for app discovery, manifest inspection, checks, help, and
  non-mutating app operations.
- `execute app:<id>` for mutating app operations.
- Contact reads require explicit contact-read capabilities or contact-policy
  provider output.

Direct local CLI execution without a resolved principal MAY remain an explicit
local-operator path. Runtime execution with an agent context MUST NOT use local
discovery as an authorization bypass.

## Agent Visibility Migration

- DB initialization MUST ensure the default agent materializes `view agent:*`
  from provider-owned config.
- `agents create` under a runtime creator MUST persist
  `view agent:<created-agent-id>` for that creator through provider-owned
  config.
- WhatsApp group creation with `--create-agent` MUST apply the same creator
  visibility rule.
- The migration MUST be idempotent.
- `doctor --domain permissions` MUST detect when the default operator agent
  cannot view registered agents.

## Delegation

For a user-initiated turn:

```text
effective_caps =
  agent_caps
  INTERSECT (actor_caps OR actor_overrides)
  INTERSECT (surface_constraints OR surface_overrides OR inherited_actor_caps_when_no_surface_decision)
  INTERSECT turn_caps
```

Rules:

- Explicit deny on any branch vetoes the capability.
- A surface with no explicit decision for the same object inherits the actor
  branch.
- Surface constraints bound the surface to expanded constraint capabilities.
- Delegation overrides cannot exceed the executor-agent ceiling.
- Automation and unresolved actors do not receive human delegation overrides.

## Profiles And Tags

Profiles are reusable capability bundles. A profile grants authority only when
a provider materializes the profile membership or equivalent capability into
the subject branch.

Permission tags are valid selectors only when a provider explicitly consumes
them. Generic CRM, classification, tier, or state tags MUST NOT authorize
runtime behavior.

## Audit

Denied authorization events MUST include safe provenance: provider id, reason
code, canonical action, canonical object, context kind, branch metadata when
available, and snapshot capability counts clearly labeled as snapshots.

Audit records MUST NOT include context keys, raw secret env values,
credentials, or arbitrary private runtime metadata.
