---
id: apps/scaffold
title: "Ravi App Scaffold"
kind: capability
domain: apps
capability: scaffold
capabilities:
  - scaffold
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

The scaffold creates an app contract, not a finished domain implementation. It
SHOULD generate enough structure for agents, UIs, SDK clients, and operators to
discover, inspect, validate, and continue implementing the app safely.

## Invariants

- `ravi apps scaffold <app-id>` MUST generate a valid `ravi.app.json` by default.
- Scaffolded manifests MUST use `schema: "ravi.app/v1"`.
- Scaffolded app ids MUST satisfy the app id pattern from `apps/manifest`.
- The scaffold MUST NOT overwrite existing files unless `--force` is passed.
- `--dry-run` MUST report the planned files without writing them.
- The default scaffold SHOULD create:
  - `src/apps/<app-id>/ravi.app.json`;
  - `.ravi/specs/apps/<app-id>/SPEC.md`;
  - `src/plugins/internal/ravi-system/skills/<app-id>/SKILL.md`.
- Scaffolded manifests SHOULD include CLI, operations, UI descriptor, skills,
  health, storage, events, and versioning sections.
- Scaffolded manifests SHOULD default `interfaces.cli.command` to
  `ravi <app-id>` as the operator-facing alias once the app router exists.
- Scaffolded UI MUST satisfy `apps/ui`.
- Scaffolded operations MUST reference declared interfaces.
- Scaffolded operations SHOULD use router-safe builtin operations for initial
  help, show, check, and placeholder read operations until real domain
  implementation exists.
- The scaffold MUST NOT generate operation commands that recursively invoke
  `ravi <app-id> <operation>` for the same app id.
- The scaffold MUST NOT generate health commands that recursively invoke
  `ravi <app-id> check` for the same app id.
- Scaffolded skills MUST teach agents to start from `ravi apps show`, validate
  with `ravi apps check`, and use declared operations only.
- The scaffold MUST NOT execute generated commands, health checks, app code, or
  storage migrations.
- Scaffold-from-CLI behavior, whether exposed as `ravi apps import-cli` or
  `ravi apps scaffold --from-cli`, MUST follow `apps/import-cli`.

## Command Contract

```bash
ravi apps scaffold <app-id> \
  --name "Display Name" \
  --description "What this app does" \
  --command "ravi my-app" \
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
- `ravi apps scaffold example --json` SHOULD write files in an empty repo.
- `ravi apps check example --json` SHOULD pass immediately after scaffold.
- After app router support exists, scaffolded apps SHOULD be invokable through
  `ravi apps run example check --json` without adding a static CLI command.
- After app router support exists, scaffolded apps SHOULD be invokable through
  `ravi example check --json` when `example` has no static command collision.
- Re-running scaffold without `--force` SHOULD fail if target files exist.
- Re-running scaffold with `--force` MAY overwrite scaffold files.

## Known Failure Modes

- Treating scaffold as finished implementation.
- Overwriting an existing app without explicit force.
- Creating an app skill but not listing it in the manifest.
- Generating UI buttons with no backing operations.
- Generating CLI operations that do not support JSON.
- Generating CLI operations that recursively call the app router alias.
- Generating health checks that recursively call the app router alias.
