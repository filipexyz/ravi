---
id: apps/visibility
title: "App Visibility"
kind: capability
domain: apps
capability: visibility
capabilities:
  - discovery
  - rebac
  - cli
  - router
tags:
  - apps
  - permissions
  - discovery
  - manifests
applies_to:
  - src/apps/router.ts
  - src/apps/service.ts
  - src/cli/commands/apps.ts
  - src/cli/index.ts
  - src/permissions/scope.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# App Visibility

## Intent

App visibility ensures a principal cannot discover or inspect apps it cannot
use.

Apps are operational capability boundaries. A manifest can reveal tool
surfaces, executable paths, SDK routes, permission requirements, and installed
product capabilities. Therefore app discovery is authorized disclosure, not a
free catalog.

## Invariants

- Under runtime context, app discovery MUST require `use app:<app-id>`.
- `apps list` MUST only return visible apps.
- `apps show <app-id>` MUST require `use app:<app-id>`.
- `apps check <app-id>` MUST require `use app:<app-id>` before returning
  manifest errors, warnings, paths, or health state.
- `apps check --all` MUST check only visible apps under runtime context unless
  an explicit operator/admin mode is used.
- Root-level dynamic aliases MUST only resolve for visible apps.
- Router builtin `help`, `show`, and `check` MUST be treated as non-mutating
  app operations and require `use app:<app-id>`.
- Mutating operation dispatch MUST require `execute app:<app-id>`.
- Manifest permission declarations MUST NOT grant visibility or execution.
- Direct local CLI execution without a principal MAY inspect all manifests as
  an operator path.

## Permission Pattern

```text
agent:<id> use app:<app-id>       # discover, show, check, non-mutating run
agent:<id> execute app:<app-id>   # mutating run by exact app id
role:<id> use app:<app-id>        # profile-backed discovery/use
role:<id> execute app:<app-id>    # profile-backed mutation
```

`execute app:<id>` does not replace `use app:<id>` for broad discovery.
Operators SHOULD grant both when the principal should see and mutate the app.

## Error Shape

- Hidden apps SHOULD appear missing to list/show/check/alias discovery.
- Permission-denied errors MAY be used for exact operation dispatch after an
  app id was already supplied, but they MUST NOT include hidden manifest path,
  source root, validation errors, or operation metadata.

## Acceptance Criteria

- A runtime agent without `use app:khal-tasks` does not see `khal-tasks` in
  `apps list --json`.
- The same agent receives a not-found-equivalent result for
  `apps show khal-tasks --json`.
- The root command `ravi khal-tasks ...` does not resolve as an app alias for
  a hidden app.
- A runtime agent with `use app:khal-tasks` can inspect and run non-mutating
  operations.
- A runtime agent with `use` but without `execute` is denied for mutating
  operations.
- A runtime agent with `execute` but without `use` does not discover the app in
  broad listings.
