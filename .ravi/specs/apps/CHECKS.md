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
- `ravi apps scaffold <id> --json` must create a runnable CLI, manifest, spec,
  and skill files.
- Duplicate scaffold without `--force` must return typed `already_exists` error.

## Manifest Checks

- Every scaffolded app must have `src/apps/<id>/ravi.app.json`.
- Default scaffolds must have `src/apps/<id>/cli.ts`, and
  `ravi <id> list --json` must execute it through the App Router.
- Manifest must contain `id`, `name`, `interfaces.cli`, `context.allow`, and
  valid permission declarations.
- `ravi apps show <id> --json` must return the parsed manifest.
- App operations must use `interface: "cli"` except router-owned allowlisted
  builtins.
- SDK, tool, stream, UI, and automation clients must route through the generic
  App Router instead of declaring independent operation executors.

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
- Runtime dispatch must issue a fresh child context bounded by
  `manifest.context.allow`.
- The child process must receive the child key and must not receive the parent
  `RAVI_CONTEXT_KEY` or synthesized Ravi identity env vars.
- Failure to issue the requested child capabilities must fail before spawning
  the app CLI.

## CLI Contract Checks

- App invocation must preserve argv, stdout, stderr, and exit status.
- The launcher must spawn executable plus argv with `shell: false`; shell-like
  input must remain literal data.
- The child cwd must be bounded to the app/package root, and the environment
  must exclude unrelated parent credentials and secrets.
- `--json` must return structured output when declared, but must not be required
  as an App-to-Ravi transport.
- App calls to Ravi must use public `ravi ...` commands under the child context.

## Suggested Commands

```bash
bun test src/cli/commands/apps.test.ts
bun test src/apps/service.test.ts src/apps/router.test.ts src/apps/permissions.test.ts
bun run typecheck
bun run build
```
