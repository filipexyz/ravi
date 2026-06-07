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
  - context
  - packaging
  - agent-operation
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
- A Ravi App running inside Ravi runtime MUST use `RAVI_CONTEXT_KEY` as its
  canonical identity and authorization bridge. It MUST NOT reconstruct identity
  from `RAVI_AGENT_ID`, `RAVI_SESSION_KEY`, or ad-hoc environment variables.
- A Ravi App SHOULD have a skill when agents are expected to use it. The skill
  MUST teach when to use the app, which commands to call, what outputs mean,
  and what failures require user input.
- New first-party Ravi Apps SHOULD be created with `ravi apps scaffold` so the
  manifest, spec, skill, operations, storage/events contract, and follow-up
  commands start from the same app contract.
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
- Apps do not bypass REBAC, context-key authorization, skill gates, or runtime
  provider boundaries.

## Validation

- A new app spec SHOULD be retrievable with `ravi specs get apps/<capability>`.
- A stateful app SHOULD expose a health/check command or documented check.
- A CLI-backed app SHOULD satisfy `apps/cli` before agents rely on it.

## Known Failure Modes

- Script-only tools with no JSON output force agents to parse human prose.
- Skills that compensate for a vague CLI create brittle agent behavior.
- CLIs that use raw session env vars lose lineage and permission audit.
- One generic database for unrelated apps creates unclear data ownership.
- Plugins treated as permission grants cause unsafe capability assumptions.
- Apps with no health/check surface fail silently inside automations.
- Apps that depend on generated root CLI commands for discovery cannot behave
  like runtime-installed ecosystem apps.
