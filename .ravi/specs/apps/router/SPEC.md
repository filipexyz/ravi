---
id: apps/router
title: "Ravi App Router"
kind: capability
domain: apps
capability: router
capabilities:
  - runtime-routing
  - cli-alias
  - operation-dispatch
  - permissions
  - audit
tags:
  - apps
  - router
  - cli
  - runtime
  - operations
applies_to:
  - src/apps/router.ts
  - src/apps/service.ts
  - src/cli/index.ts
  - src/cli/commands/apps.ts
  - src/cli/registry.ts
  - src/cli/audit.ts
  - src/permissions
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi App Router

## Intent

Resolve Ravi App CLI routes at runtime from app manifests.

The app router lets a newly discovered app become operable without generating a
new TypeScript command file, rebuilding the CLI, regenerating the SDK, or adding
a static Commander registration for every app.

Canonical command:

```bash
ravi apps run <app-id> [operation] [args...] --json
```

Operator sugar:

```bash
ravi <app-id> [operation] [args...] --json
```

## Invariants

- App route resolution MUST be runtime-based. A newly discovered valid manifest
  MUST NOT require build-time command registration to be invokable through
  `ravi apps run <app-id>`.
- Static CLI commands MUST take precedence over dynamic app ids.
- `ravi apps run <app-id> ...` is the canonical dispatch path. `ravi <app-id>
  ...` is only a root-level alias for the same router.
- The root-level alias MUST activate only when the first argv token is not a
  registered static command, is a valid discovered app id, and is visible to
  the current runtime context.
- Unknown root commands MUST continue to fail through the normal CLI error/help
  path. The app router MUST NOT swallow unrelated Commander errors.
- The router MUST validate the app manifest before dispatching an operation.
- Invalid manifests, duplicate app ids, malformed operations, or missing
  operation executors MUST fail before any app code is executed.
- Duplicate app ids are a hard routing conflict. The router MUST report the
  conflicting manifest sources and MUST NOT choose one implicitly.
- The router MUST resolve operations deterministically.
- `ravi <app-id>` SHOULD show app help/summary.
- `ravi <app-id> show` SHOULD show the app manifest summary.
- `ravi <app-id> check` SHOULD run app manifest/health validation.
- `ravi <app-id> <operation>` MUST map to a declared operation id, declared
  alias, or router-owned builtin.
- Router-owned builtin operations MUST use an explicit allowlisted handler.
- CLI-backed operations MUST NOT recursively invoke the same public dynamic
  alias, such as `ravi <app-id> <operation>`.
- CLI-backed operations SHOULD be external commands or static internal Ravi
  commands that do not re-enter the same dynamic route.
- The router MUST perform manifest permission preflight before dispatch.
- The router MUST still rely on runtime authorization at execution time for
  mutating, sensitive, externally visible, or identity-dependent operations.
- When a runtime/agent principal exists, the router MUST authorize the app
  object before dispatch:
  - non-mutating operation: `use app:<app-id>`;
  - mutating operation: `execute app:<app-id>`.
- When a runtime/agent principal exists, router-owned discovery builtins
  (`help`, `show`, `check`) MUST require `use app:<app-id>` before returning
  manifest details, validation errors, operation ids, or next commands.
- Mutating operations MUST declare `permission` or `permissions`.
- When a child process or tool execution is launched inside Ravi runtime, the
  router SHOULD pass `RAVI_CONTEXT_KEY` when available and MUST NOT expose raw
  secrets or bearer tokens.
- The router MUST emit audit metadata for app dispatch attempts, including
  `appId`, `operationId`, `interface`, `mutating`, status, duration, and error
  class when available.
- `--json` MUST produce machine-readable output for router success and failure
  states.
- Discovery and help/show/list operations MUST NOT execute app binaries, run
  health checks, import arbitrary code, or mutate storage.
- Stream operations MUST NOT be faked as single-shot CLI output. The router
  SHOULD return the stream/control channel contract or hand off to a dedicated
  streaming surface.
- Dynamic app routes MUST NOT be added to the static SDK decorator registry by
  default. SDK clients should use `apps.run` unless the app has a separate
  generated SDK route.

## Command Contract

```bash
ravi apps run <app-id> [operation] [args...] --json
ravi <app-id> [operation] [args...] --json
```

Argument handling:

- `<app-id>` is the manifest id.
- `[operation]` defaults to router help/summary when omitted.
- Remaining args are operation-specific and MUST be passed only after the
  operation executor has been resolved and authorized.
- Global CLI flags such as `--json` MUST retain their normal behavior.

## Resolution Order

1. Registered static CLI commands.
2. `ravi apps run <app-id> ...`.
3. Root-level dynamic app alias `ravi <app-id> ...`.
4. Normal CLI unknown-command handling.

Static commands include generated/decorated first-party commands and manually
registered root commands. A manifest id that collides with a static command is
still discoverable, but its root alias is disabled. Operators and agents MUST
use `ravi apps run <app-id> ...` for that app.

## Operation Executor Contract

Operations MAY dispatch to one of these interfaces:

- `builtin`: router-owned allowlisted handler.
- `cli`: child process command that supports the declared machine contract.
- `sdk`: SDK/gateway namespace and method.
- `tool`: explicit runtime tool name and input mapping.
- `stream`: stream/control channel declaration.

Builtin operations MUST declare `handler`, such as `apps.manifest.show`,
`apps.manifest.check`, `apps.help`, or another router-owned allowlisted
handler.

CLI operations MUST declare `command`. The command MUST NOT begin with the same
dynamic alias being resolved, such as `ravi <app-id>` for the current app id.

SDK operations MUST declare `namespace` and `method`.

Tool operations MUST declare `name`.

Stream operations MUST declare `channel`.

## Boundaries

- The app router is not an app discovery index by itself. It consumes the app
  service/registry and refuses ambiguous or invalid entries.
- The app router is not a permission grant. Manifest permissions describe
  requirements; runtime authorization remains authoritative.
- `use app:<id>` and `execute app:<id>` are the app isolation boundary for
  runtime dispatch. Manifest permissions MUST NOT be interpreted as grants.
- The app router is not a replacement for first-party static CLI commands.
  Stable core commands may remain build-time registered when they need SDK
  codegen, decorators, or custom parser behavior.
- The root-level alias is an ergonomic launcher only. The durable contract is
  `ravi apps run`.

## Validation

- `ravi specs get apps/router --mode rules --json` MUST return this contract.
- A valid new app manifest SHOULD become invokable through
  `ravi apps run <app-id> check --json` without rebuilding the CLI.
- A valid new app manifest SHOULD become invokable through
  `ravi <app-id> check --json` when its id does not collide with a static
  command.
- A manifest id that collides with a static command SHOULD remain invokable
  through `ravi apps run <app-id> ...`.
- A hidden manifest id SHOULD NOT resolve as a root-level dynamic alias.
- In agent/runtime context, `ravi apps run <app-id> check --json` MUST fail
  without `use app:<app-id>`.
- In agent/runtime context, a mutating operation MUST fail without
  `execute app:<app-id>` even when `use app:<app-id>` is present.

## Known Failure Modes

- Registering every app as a generated TypeScript command makes the ecosystem
  build-time instead of runtime.
- Letting a dynamic alias override a static command breaks established CLI
  contracts.
- Declaring a CLI operation as `ravi <app-id> <operation>` creates recursive
  routing.
- Treating manifest permissions as grants bypasses REBAC and context-key
  authorization.
- Running health checks during discovery creates side effects and slow startup.
- Hiding app route failures behind generic Commander help makes agents unable
  to diagnose missing manifests or invalid operations.
