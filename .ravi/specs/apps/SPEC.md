---
id: apps
title: "Ravi Apps"
kind: domain
domain: apps
capabilities:
  - builder
  - cli
  - lifecycle
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

An app is a CLI application with a declarative `ravi.app.json`. Humans and
agents invoke it through `ravi <app-id> <operation>`. The App Router validates
the manifest and caller authority, issues a least-privilege child context, then
launches the app CLI.

The app talks back to Ravi by invoking public `ravi ...` commands with the child
`RAVI_CONTEXT_KEY`. There is no separate App JSON-RPC, host callback, SDK
transport, or app-specific protocol. Arguments, stdout, stderr, and exit status
are the process contract. `--json` is an optional machine-readable output mode,
not the transport between the app and Ravi.

This domain protects the distinction between:

- app: a CLI application plus its operational contract;
- plugin: a packaging and discovery container;
- skill: the agent teaching layer;
- App Router: the Ravi launcher for app CLIs;
- Ravi Command: a prompt template, not an app by itself.

## Invariants

- A Ravi App MUST have a stable app id.
- A Ravi App MUST define the operational problem it solves before defining its
  command surface.
- A Ravi App MUST declare one canonical CLI implementation under
  `interfaces.cli`.
- App operations MUST dispatch to that CLI. Router-owned allowlisted builtins
  MAY implement discovery, help, manifest inspection, and manifest validation.
- Ravi App routing MUST be runtime-resolved through the App Router instead of
  requiring build-time command registration for each app.
- UI, SDK clients, runtime tools, and automations MUST invoke the same declared
  operations through the generic App Router. They MUST NOT create independent
  app executors or business implementations.
- `--json` MAY be used when a caller needs structured output. It MUST NOT be
  described or implemented as an App-to-Ravi protocol.
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
- Before launching an app CLI inside a Ravi runtime, the App Router MUST issue a
  fresh least-privilege child context from the caller context.
- The child context capability ceiling MUST be derived from the manifest's
  explicit `context.allow` declaration and MUST NOT exceed the parent context.
- The launcher MUST pass the child `RAVI_CONTEXT_KEY` as the only Ravi identity
  credential. It MUST NOT forward the parent context key or synthesize identity
  with `RAVI_AGENT_ID`, `RAVI_SESSION_KEY`, `RAVI_SESSION_NAME`, or ad-hoc
  environment variables.
- The launcher MUST parse declarative commands into executable plus argv and
  spawn without a shell. User-supplied app arguments MUST remain literal argv.
- The launcher MUST use a bounded app-root working directory and an allowlisted
  environment that excludes unrelated parent credentials and secrets.
- A Ravi App running inside Ravi MUST resolve identity and authority through
  `ravi context whoami`, `ravi context check`, or
  `ravi context authorize`, then use ordinary public `ravi ...` commands for
  Ravi capabilities.
- Child contexts MUST have a stable audit name, bounded TTL, lineage to the
  parent context, and no raw key in logs or audit payloads.
- `context.allow` is a requested child-context ceiling, not a grant. Failure to
  issue the declared capability MUST fail before the app CLI starts.
- A Ravi App SHOULD have a skill when agents are expected to use it. The skill
  MUST teach when to use the app, which commands to call, what outputs mean,
  and what failures require user input.
- New first-party Ravi Apps SHOULD be created with `ravi apps scaffold` so the
  runnable thin CLI, manifest, spec, skill, operations, storage/events contract,
  and follow-up commands start from the same app contract.
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
  commands so other agents and UIs can observe them without scraping human
  stdout.

## App Contract

Every `ravi.app.json` SHOULD document:

- `id`: stable app slug;
- `name`: human display name;
- `interfaces.cli`: the real CLI implementation entrypoint;
- `interfaces.ui`: optional semantic UI descriptor;
- `operations`: public app operations mapped to CLI commands or router builtins;
- `permissions`: required Ravi capabilities/scopes;
- `context.allow`: Ravi capabilities requested for the child CLI context;
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
  apps are executable CLIs with storage, events, and skills when useful.
- Apps do not bypass the Permission Provider Runtime, context-key
  authorization, skill gates, or runtime provider boundaries.
- Apps do not get a private Ravi SDK or a second transport contract. An app
  calls the public Ravi CLI under its child context.
- UI, SDK, tool, and automation surfaces are clients of the App Router, not
  alternative app implementations.
- Direct local CLI execution with no resolved principal MAY remain an operator
  break-glass path, but any execution carrying `agentId` or `RAVI_CONTEXT_KEY`
  MUST authorize through the Permission Provider Runtime. Runtime discovery
  carrying `agentId` or `RAVI_CONTEXT_KEY` MUST filter to app-visible decisions
  equivalent to `use app:<app-id>`.

## Validation

- A new app spec SHOULD be retrievable with `ravi specs get apps/<capability>`.
- A stateful app SHOULD expose a health/check command or documented check.
- Every app SHOULD satisfy `apps/cli` before agents rely on it.
- A CLI-imported app SHOULD satisfy `apps/import-cli` before generated
  manifests are written or trusted.

## Apps Command Inventory

The public Apps management registry consists of:

- `ravi apps list`
- `ravi apps show`
- `ravi apps check`
- `ravi apps scaffold`
- `ravi apps delete`
- `ravi apps import-cli`
- `ravi apps guide`
- `ravi apps prompts`

`ravi apps run` is an internal/debug router surface. Normal product invocation
uses `ravi <app-id> <operation>`.

This inventory MUST remain aligned with the decorated registry,
`RAVI_APPS_COMMAND_GUIDANCE`, `ravi apps guide`, and `ravi-system-apps`.
App construction MUST follow `apps/builder`; scaffold and import results MUST
link the canonical `ravi-dev-app-creator` skill, the `apps/builder` spec, and
the structured readiness checklist.

## Known Failure Modes

- Script-only tools with no JSON output force agents to parse human prose.
- Skills that compensate for a vague CLI create brittle agent behavior.
- CLIs that use raw session env vars lose lineage and permission audit.
- Launchers that forward the parent context key give apps the caller's full
  authority.
- Separate SDK, tool, or UI executors make the same app behave differently by
  surface.
- Treating `--json` as a host protocol adds a transport that the CLI does not
  need.
- Shell execution or full parent-environment inheritance turns the app launcher
  into an injection and credential-leak boundary.
- One generic database for unrelated apps creates unclear data ownership.
- Plugins treated as permission grants cause unsafe capability assumptions.
- Apps with no health/check surface fail silently inside automations.
- Apps that depend on generated root CLI commands for discovery cannot behave
  like runtime-installed ecosystem apps.
