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
- `agent-identity-permissions`
- `contact-policy-permissions`

The command surface for permissions has two layers:

Inspection:

```bash
ravi permissions status
ravi permissions check --permission <perm> --object-type <type> --object-id <id>
ravi permissions materialize --subject-type <type> --subject-id <id>
```

Provider-owned orchestration:

```bash
ravi permissions allow <profile> --to contact:<id> --agent <agent-id> --capabilities <perm>:<type>:<id>
ravi permissions resolve <denial-id>
```

`ravi permissions allow` and `ravi permissions resolve` MUST NOT write to a
native permission graph. They are orchestration commands that mutate only the
provider-owned surfaces already used by materializers:

- permission-scoped tags: `kind=system`, `source=permissions`;
- `agent.defaults.runtimePermissions` consumed by
  `agent-runtime-permissions` and projected into
  `agent-identity-permissions`;
- contact policy tags consumed by `contact-policy-permissions` for
  legacy/user-overlay policy, not the default multiplayer tool authority path.

Both commands MUST dry-run by default and require `--apply` to persist changes.
Direct agent-only authority mutation MAY still use `ravi agents permissions`,
but operator and agent guidance SHOULD prefer `ravi permissions allow/resolve`
for recurring user/workflow access because it updates the agent identity in one
explainable plan. Contact/user profile changes are legacy/user-overlay unless a
future policy explicitly uses them for invocation eligibility.

## Agent-Facing Authorization UX

Agents MUST be guided toward explainable least-privilege requests.

- Permission denials MUST expose the canonical missing capability in
  `<permission>:<objectType>:<objectId>` form.
- Permission denials, approval prompts, and CLI JSON outputs SHOULD use the
  shared authorization guidance envelope instead of hand-written local hints.
  The envelope MUST include:
  - `canonicalCapability`;
  - subject when known;
  - scope (`current-context`, `recurring`, or `diagnostic`);
  - inspection command(s);
  - preferred provider-owned profile/tag path;
  - raw capability fallback;
  - break-glass warning;
  - request shape for agents to ask operators.
- Denial output, audit payloads, and CLI hints SHOULD recommend a
  provider-owned permission profile/tag before suggesting raw capability
  grants.
- When an existing provider-owned permission tag matches the missing
  capability, the guidance SHOULD name that tag explicitly.
- Raw capability grants are acceptable only when no profile exists yet, or when
  an operator is intentionally creating a new narrow profile.
- `full-access` MUST be described as break-glass in prompts, CLI hints, specs,
  and skills. It MUST NOT appear as the normal next step after creating an
  agent or diagnosing a denial.
- Approval prompts for a single runtime capability MUST state that the grant is
  scoped to the current context. Recurring access MUST be modeled as a
  provider-owned profile/tag.
- Agents asking for authorization MUST include: the missing canonical
  capability, the blocking branch when known, the profile/tag they recommend,
  the command used for inspection, and whether the fallback is break-glass.
- Agents MUST ask in product terms first:
  "I need profile/tag X for workflow Y in scope Z." Raw capability strings are
  supporting evidence, not the main request body.
- Agents SHOULD use `ravi permissions resolve <denial-id>` when a denial id is
  available. The resolve command MUST infer the missing capability from the
  recorded denial and produce the least-privilege provider-owned plan.
- Agents SHOULD use `ravi permissions allow <profile> --to <subject> --agent
  <agent-id>` for recurring access instead of emitting long raw command lists.
  Raw capabilities belong in `--capabilities` as profile bootstrap evidence.
- CLI hints MUST present `ravi permissions allow/resolve` before lower-level
  `ravi agents permissions` or tag mutation commands.

## Invariants

- Ravi MUST fail closed when the effective principal, action, object, or context
  cannot be resolved.
- Permission checks MUST use canonical Ravi subjects and objects, not raw
  provider ids, display names, phone numbers, or chat titles.
- Contacts, agents, chats, sessions, automations, observers, roles, and system
  actors are distinct principals.
- External shared-surface execution MUST be authorized by
  `agent_identity:<agent>:<compartment>` and any explicit turn caps. The
  actor/contact is required provenance and invocation context, not a default
  tool-authority branch.
- Unknown or unresolved external actors MUST fail closed and receive no
  materialized agent identity capabilities.
- Groups/chats/threads select the agent identity compartment by default. A
  surface with no provider-owned policy MUST NOT zero the agent identity.
- User/contact-level checks MAY be added later as an overlay on top of agent
  identity, but they MUST NOT replace the active agent identity model without a
  normative spec and tests.
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
- `agent_identity`: effective Ravi agent identity scoped to a compartment such
  as `chat:<id>`, `dm:<id>`, `automation:<id>`, or `workspace:<id>`.
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

## Agent Identity

For an external resolved turn:

```text
effective_caps =
  agent_identity_caps
  INTERSECT turn_caps_when_present
```

Rules:

- The default authority mode is `agent-identity`.
- `agent_identity` capabilities are materialized from the executor agent's
  provider-owned runtime config and runtime bootstrap.
- `actorPrincipal` and `surfacePrincipal` MUST be present in metadata when
  resolved, but their materialized capability counts are audit snapshots and do
  not gate tool authority in the default model.
- `ravi permissions resolve <denial-id>` for an agent-identity denial MUST
  target `agent:<executorAgentId>`.

## Retired Delegation

The previous delegated intersection is retired from runtime context creation.
It remains only as historical spec context and isolated test fixtures.

Retired formula:

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

Specs, skills, prompts, and CLI guidance MUST NOT present this legacy
intersection as the production default.

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
