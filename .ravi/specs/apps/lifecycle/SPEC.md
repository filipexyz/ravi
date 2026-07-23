---
id: apps/lifecycle
title: "Ravi App Lifecycle"
kind: capability
domain: apps
capability: lifecycle
capabilities:
  - scaffold
  - delete
  - manifest
  - errors
tags:
  - apps
  - lifecycle
  - scaffold
  - delete
  - errors
applies_to:
  - src/apps/scaffold.ts
  - src/apps/service.ts
  - src/apps/types.ts
  - src/cli/commands/apps.ts
  - src/sdk/gateway/dispatcher.ts
  - src/sdk/gateway/errors.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi App Lifecycle

## Intent

Define the scaffold-to-delete lifecycle for Ravi Apps created by `ravi apps
scaffold`. This spec governs creation collision behavior, safe deletion of
scaffold-owned artifacts, and the typed error contract across CLI, JSON, SDK,
gateway, and OpenAPI surfaces.

## Invariants

### Delete Contract

- `ravi apps delete <app-id>` MUST only remove scaffold-owned artifacts.
- Scaffold-owned artifacts are:
  - `src/apps/<id>/ravi.app.json`
  - `.ravi/specs/apps/<id>/SPEC.md`
  - generated skill `src/plugins/internal/ravi-system/skills/<slug>/SKILL.md`
  - empty directories left after removal, only when empty and clearly within
    scaffold-owned paths.
- Delete MUST NOT remove runtime storage, artifacts, events, credentials,
  migrations, implementation files, or anything not clearly scaffold-owned.
- Delete MUST NOT execute app code, health checks, storage migrations, runtime
  commands, or credential access.
- Delete MUST support `--dry-run` to report planned actions without writing.
- Delete MUST report artifact path, kind, and planned action for each file.
- Delete of an absent app MUST return a typed `not_found` error.

### Scaffold Collision

- `ravi apps scaffold <app-id>` without `--force` MUST return a typed
  `already_exists` error when scaffold target files already exist.
- The `already_exists` error MUST include bounded evidence (paths that exist)
  and suggested next steps.

### Typed Error Contract

- Typed errors MUST include a stable `code`, human `message`, numeric `status`,
  and bounded `evidence` array.
- Error codes: `already_exists` (HTTP 409), `not_found` (HTTP 404).
- Evidence items MUST NOT leak secrets, context keys, or paths outside the repo.
- CLI surfaces MUST print human-legible error messages.
- JSON, SDK, gateway, and OpenAPI surfaces MUST return structured error bodies
  with stable `error` code and `status` fields.

### Show/Check Absent App

- `ravi apps show <absent-id>` MUST return a typed `not_found` error.
- `ravi apps check <absent-id>` MUST return a typed `not_found` error.

### SDK Surface

- SDK-facing commands MUST use concrete `@Returns(zod)` schemas.
- Generated command and SDK artifacts MUST remain stable after changes.

## Boundaries

- This spec governs scaffold-owned artifact lifecycle only.
- Plugin or global uninstall is out of scope.
- Broad SDK error redesign is out of scope.
- Permissions domain work beyond typed error surfaces is out of scope.
- Health checks, command execution, or app code execution during delete is
  forbidden.

## Validation

- `ravi apps delete <app-id> --dry-run --json` reports planned removals.
- `ravi apps delete <app-id> --json` removes scaffold-owned files.
- `ravi apps delete <absent-id> --json` returns `not_found` with status 404.
- `ravi apps scaffold <existing-id> --json` without `--force` returns
  `already_exists` with status 409.
- `ravi apps show <absent-id> --json` returns `not_found` error.
- SDK and command generation checks pass after changes.
