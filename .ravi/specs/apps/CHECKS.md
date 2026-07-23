---
id: apps
title: "Ravi Apps Checks"
kind: domain
domain: apps
status: active
normative: false
---

# Ravi Apps Checks

## Scaffold Checks

- `ravi apps scaffold <id> --dry-run --json` must return planned file paths
  and actions without creating files.
- `ravi apps scaffold <id> --json` must create manifest, spec, and skill files.
- Duplicate scaffold without `--force` must return typed `already_exists` error.

## Manifest Checks

- Every scaffolded app must have `src/apps/<id>/ravi.app.json`.
- Manifest must contain `id`, `name`, and valid permission declarations.
- `ravi apps show <id> --json` must return the parsed manifest.

## Lifecycle Checks

- `ravi apps delete <id> --dry-run --json` must report planned removals
  without executing.
- `ravi apps delete <id> --json` must remove only scaffold-owned artifacts.
- Delete must preserve implementation files, runtime storage, and credentials.
- Absent app operations must return typed `not_found` error with status 404.

## Permission Checks

- App discovery requires a provider-runtime decision equivalent to
  `use app:<app-id>`.
- App mutation requires `execute app:<app-id>`.
- Apps not visible to the current principal must not appear in catalogs or
  SDK discovery.

## SDK Checks

- `bun run sdk:generate` and `bun run sdk:check` must pass after app changes.
- `ravi sdk returns validate --json` must report zero issues.

## Suggested Commands

```bash
bun test src/cli/commands/apps.test.ts
bun test src/apps/service.test.ts src/apps/router.test.ts src/apps/permissions.test.ts
bun test src/sdk/gateway/dispatcher.test.ts
bun run gen:commands
bun run sdk:generate
bun run sdk:check
bun run typecheck
bun run build
```
