---
id: apps/scaffold
title: "Ravi App Scaffold"
kind: capability
domain: apps
capability: scaffold
capabilities:
  - scaffold
  - lifecycle
  - import-cli
  - manifest
  - router
  - skills
  - specs
  - ui
tags:
  - apps
  - scaffold
  - manifest
  - skill-gate
applies_to:
  - src/apps/scaffold.ts
  - src/cli/commands/apps.ts
  - src/plugins/internal/ravi-system/skills/apps/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi App Scaffold

## Intent

Define the generator that creates the initial files for a Ravi App.

The scaffold creates an app contract plus a runnable thin CLI, not a finished
domain implementation. It SHOULD generate enough structure for agents, UI
clients, generic App Router clients, and operators to discover, inspect,
validate, invoke, and continue implementing the CLI safely.

## Invariants

- `ravi apps scaffold <app-id>` MUST generate a valid `ravi.app.json` by default.
- Scaffolded manifests MUST use `schema: "ravi.app/v1"`.
- Scaffolded app ids MUST satisfy the app id pattern from `apps/manifest`.
- The scaffold MUST NOT overwrite existing files unless `--force` is passed.
- Even with `--force`, the scaffold MUST preserve an existing generated
  `cli.ts`: after the first scaffold it is implementation-owned, not a
  regenerable contract file.
- `--dry-run` MUST report the planned files without writing them.
- The default scaffold SHOULD create:
  - `src/apps/<app-id>/ravi.app.json`;
  - `src/apps/<app-id>/cli.ts`;
  - `.ravi/specs/apps/<app-id>/SPEC.md`;
  - `src/plugins/internal/ravi-system/skills/<app-id>/SKILL.md`.
- Scaffolded manifests SHOULD include CLI, operations, `context.allow`, optional
  UI descriptor, skills, health, storage, events, and versioning sections.
- Scaffolded manifests SHOULD default `interfaces.cli.command` to
  `bun cli.ts` and generate that implementation entrypoint when no
  `--command` is supplied.
- When `--command` is supplied, the scaffold MUST use that real implementation
  command and MUST NOT generate `cli.ts`.
- Scaffolded manifests MUST NOT use `ravi <app-id>` as
  `interfaces.cli.command`; that is the router alias, not the app CLI.
- Scaffolded `context.allow` MUST default to an empty array and require explicit
  review before capabilities are added.
- Scaffolded UI MUST satisfy `apps/ui`.
- Scaffolded operations MUST reference declared interfaces.
- Scaffolded discovery operations SHOULD use router-safe builtins for initial
  help, show, and check. The default read operation MUST invoke the generated
  CLI so scaffold-to-router execution is real on day one.
- Scaffold MUST NOT generate SDK, tool, or stream operation executors. Those
  caller surfaces use the generic App Router.
- The scaffold MUST NOT generate operation commands that recursively invoke
  `ravi <app-id> <operation>` for the same app id.
- The scaffold MUST omit `interfaces.cli.health` by default unless the supplied
  CLI contract declares a safe non-mutating health command.
- A generated health command MUST use the real implementation CLI. It MUST NOT
  target the public `ravi <app-id>` alias or the router-owned `check` builtin.
- Scaffolded skills MUST teach agents to start from `ravi apps show`, validate
  with `ravi apps check`, and operate declared operations through
  `ravi <app-id> <operation>`.
- Scaffold output MUST link `ravi-dev-app-creator`, `apps/builder`, and the
  complete structured builder review checklist. This guidance is part of the
  generator contract even when `--skip-skill` or `--skip-spec` is selected.
- The scaffold command MUST NOT execute generated commands, health checks, app
  code, or storage migrations. Validation tests MAY invoke the generated CLI
  after file creation.
- Scaffold-from-CLI behavior, whether exposed as `ravi apps import-cli` or
  `ravi apps scaffold --from-cli`, MUST follow `apps/import-cli`.

## Command Contract

```bash
ravi apps scaffold <app-id> \
  --name "Display Name" \
  --description "What this app does" \
  --command "my-app-cli" \
  --from-cli "external-cli" \
  --dry-run \
  --force \
  --skip-ui \
  --skip-skill \
  --skip-spec \
  --json
```

## Validation

- `ravi apps scaffold example --dry-run --json` SHOULD return planned files.
- Scaffold JSON output MUST include `builder.skill`, `builder.command`,
  `builder.spec`, and the complete `builder.reviewChecklist`.
- `ravi apps scaffold example --json` SHOULD write files in an empty repo.
- `ravi apps check example --json` SHOULD pass immediately after scaffold.
- `ravi example list --json` SHOULD execute the generated `bun cli.ts` through
  the App Router immediately after scaffold.
- After app router support exists, scaffolded apps SHOULD be invokable through
  `ravi example check --json` when `example` has no static command collision.
- Scaffolded apps SHOULD remain invokable through
  `ravi apps run example check --json` as a router fallback/debug path.
- Re-running scaffold without `--force` SHOULD fail if target files exist.
- Re-running scaffold with `--force` MAY overwrite scaffold-owned contract
  files but MUST preserve an existing implementation `cli.ts` and report it as
  `preserved`.

## Known Failure Modes

- Treating the thin generated CLI as finished domain implementation.
- Overwriting an existing app without explicit force.
- Creating an app skill but not listing it in the manifest.
- Generating UI buttons with no backing operations.
- Generating CLI operations that do not support JSON.
- Generating CLI operations that recursively call the app router alias.
- Generating health checks that recursively call the app router alias.
- Generating broad or inherited child capabilities.
- Generating SDK/tool/stream executors that duplicate the CLI.
