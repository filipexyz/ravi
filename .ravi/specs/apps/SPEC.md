---
id: apps
title: "Ravi Apps"
kind: domain
domain: apps
capabilities:
  - cli
  - manifest
  - router
  - scaffold
  - import-cli
  - context
  - packaging
  - agent-operation
  - permission-providers
tags:
  - apps
  - ecosystem
  - cli
  - context-key
  - skills
applies_to:
  - .ravi/specs/apps
  - src/cli
  - src/plugins
  - src/sdk/gateway
  - src/runtime/context-registry.ts
  - src/permissions
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi Apps

## Intent

Ravi Apps are the application layer of Ravi OS.

An app is an operable capability unit that can be used by humans, agents, SDK
clients, UIs, or automations through one or more stable interfaces. A CLI can
be an app when it has a domain model, a machine-readable command surface,
context-bound authorization, durable state when useful, and a skill that teaches
agents when and how to operate it.

This domain protects the distinction between:

- app: the operational product/capability;
- plugin: a packaging and discovery container;
- skill: the agent teaching layer;
- CLI: one possible control surface;
- Ravi Command: a prompt template, not an app by itself.

## Invariants

- A Ravi App MUST have a stable app id.
- A Ravi App MUST define the operational problem it solves before defining its
  command surface.
- A Ravi App MUST expose at least one machine-operable interface: CLI JSON,
  SDK/gateway route, stream channel, or explicit runtime tool.
- Ravi App CLI routing SHOULD be runtime-resolved through the app router instead
  of requiring build-time command registration for each app.
- A Ravi App MUST declare the Ravi permissions or context capabilities needed
  to perform mutating or sensitive operations.
- A Ravi App MAY declare an App Permission Provider for app-owned domain
  authorization. Provider decisions specialize app resource policy inside the
  Permission Provider Runtime; they MUST NOT bypass required provider denials,
  context-key authorization, agent ceilings, skill gates, or audit rules.
- A Ravi App MUST be isolated as `app:<app-id>` through the Permission Provider
  Runtime when executed in a Ravi runtime context.
- A Ravi App MUST be isolated during discovery as well as execution.
- Non-mutating app operations require a provider-runtime decision equivalent to
  `use app:<app-id>` for the executing agent/runtime principal.
- Mutating app operations require a provider-runtime decision equivalent to
  `execute app:<app-id>` for the executing agent/runtime principal and MUST
  declare operation-level permission metadata.
- A provider-runtime decision equivalent to `use app:<app-id>` is required for
  runtime app list/show/check/help and dynamic alias discovery. An app that is
  not visible MUST NOT appear in broad catalogs, autocomplete, UI pickers, SDK
  discovery, or root aliases.
- Manifest permission declarations are requirements and audit metadata; they
  MUST NOT be treated as grants.
- A Ravi App running inside Ravi runtime MUST use `RAVI_CONTEXT_KEY` as its
  canonical identity and authorization bridge. It MUST NOT reconstruct identity
  from `RAVI_AGENT_ID`, `RAVI_SESSION_KEY`, or ad-hoc environment variables.
- A Ravi App SHOULD have a skill when agents are expected to use it. The skill
  MUST teach when to use the app, which commands to call, what outputs mean,
  and what failures require user input.
- New first-party Ravi Apps SHOULD be created with `ravi apps scaffold` so the
  manifest, spec, skill, operations, storage/events contract, and follow-up
  commands start from the same app contract.
- Existing CLIs that should become Ravi Apps SHOULD be imported or scaffolded
  from CLI metadata when available. Generated app contracts MUST be treated as
  drafts until product operations, permissions, storage, events, UI, and skills
  are reviewed.
- App generation from a CLI MUST NOT blindly expose every raw command as an app
  operation. The app surface should represent daily, safe, machine-readable
  operations; debug-only and rare commands may remain CLI-only.
- A Ravi App MAY be packaged inside a plugin, but the plugin is only the
  container. Packaging a skill or CLI in a plugin does not grant permissions and
  does not make the plugin itself the app.
- Stateful apps SHOULD own domain-specific SQLite storage when persistence
  adds reuse, lineage, auditability, expensive-cache reuse, or durable assets.
- Apps MUST NOT persist data merely because it is available. Persistence must
  add reuse, lineage, audit, cache value, or operational recovery.
- Apps that emit events or artifacts SHOULD use Ravi-owned event/artifact
  surfaces so other agents and UIs can observe them without scraping stdout.

## App Contract

Until a dedicated app manifest format exists, every app spec or implementation
SHOULD document:

- `id`: stable app slug;
- `name`: human display name;
- `interfaces`: CLI commands, SDK routes, stream channels, UIs, or tools;
- `permissions`: required Ravi capabilities/scopes;
- `permission provider`: optional app-owned authorization decision hook;
- `storage`: tables/files owned by the app;
- `artifacts`: durable outputs the app creates;
- `events`: events the app emits or consumes;
- `skill`: skill names that teach agents to operate the app;
- `health`: commands or checks that prove the app is usable;
- `versioning`: what changes require migration or compatibility handling.

## Boundaries

- Apps are not a replacement for plugins. Plugins package skills and assets;
  apps define operational behavior.
- Apps are not a replacement for `AGENTS.md`. Agents define identity and
  conversational behavior; apps define reusable capability surfaces.
- Apps are not Ravi Commands. Ravi Commands are user-invoked prompt templates;
  apps can include commands, CLIs, storage, events, and skills.
- Apps do not bypass the Permission Provider Runtime, context-key
  authorization, skill gates, or runtime provider boundaries.
- Direct local CLI execution with no resolved principal MAY remain an operator
  break-glass path, but any execution carrying `agentId` or `RAVI_CONTEXT_KEY`
  MUST authorize through the Permission Provider Runtime. Runtime discovery
  carrying `agentId` or `RAVI_CONTEXT_KEY` MUST filter to app-visible decisions
  equivalent to `use app:<app-id>`.

## Validation

- A new app spec SHOULD be retrievable with `ravi specs get apps/<capability>`.
- A stateful app SHOULD expose a health/check command or documented check.
- A CLI-backed app SHOULD satisfy `apps/cli` before agents rely on it.
- A CLI-imported app SHOULD satisfy `apps/import-cli` before generated
  manifests are written or trusted.

## Known Failure Modes

- Script-only tools with no JSON output force agents to parse human prose.
- Skills that compensate for a vague CLI create brittle agent behavior.
- CLIs that use raw session env vars lose lineage and permission audit.
- One generic database for unrelated apps creates unclear data ownership.
- Plugins treated as permission grants cause unsafe capability assumptions.
- Apps with no health/check surface fail silently inside automations.
- Apps that depend on generated root CLI commands for discovery cannot behave
  like runtime-installed ecosystem apps.
