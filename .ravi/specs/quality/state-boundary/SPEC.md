---
id: quality/state-boundary
title: "Real State and Process Roles"
kind: capability
domain: quality
capability: state-boundary
status: active
normative: true
applies_to:
  - src/db/state-boundary.ts
  - src/db/schema-owner.ts
  - src/db/runtime-state.ts
  - src/channels/runner.ts
  - src/daemon.ts
  - src/bridge/store.ts
  - src/pr/journal.ts
  - src/router/router-db.ts
  - src/test/ravi-state.ts
  - .github/workflows/ci.yml
---

# Real State and Process Roles

## Invariants

- There is one canonical real state directory (`~/.ravi`) and explicit isolated state directories. "Production environment" is not an authorization role.
- A writable SQLite connection MUST check its target before opening, moving legacy files, creating directories, returning cached handles or initializing schema. Reads through a lazy initializer can also migrate.
- Every writable state constructor MUST use `openStateDatabase`. Pure path display and explicit readonly inspectors MUST NOT initialize schema.
- Access to real state MUST be authorized by process role: installed runtime code, actual PID registered by PM2, matching executable/arguments and process manager parent. Environment names, inherited `pm_id`, cwd or argv alone MUST NOT authorize it.
- Identity validation MUST match the canonical launcher for each role: daemon registers the bundle with `daemon run`; channels registers the running Bun executable with `<bundle> channels run`. The exact arguments, bundle and executable MUST be checked; launcher-generated channel registration MUST be covered by regression tests.
- The identity check MUST use the code's location. A package containing `src` or `.git`, unknown code provenance, CLI, build, worktree or test execution MUST NOT gain real-state access by inheriting runtime environment or explicitly naming the real directory.
- Outside the registered runtime, commands MUST select isolated state explicitly, normally with `RAVI_STATE_DIR` on the command. Losing that variable MUST refuse real-state access instead of silently opening the default. Errors MUST show the variable, a command example and the installed daemon gateway alternative.
- The installed daemon is the ONLY schema owner. Before becoming ready it MUST initialize all runtime stores and record each component's successful initialization for the exact package version. Failed initialization MUST leave no ready marker.
- The registered installed `ravi-channels` process MAY open existing stores for normal traffic but MUST NOT create, migrate or repair schemas. Its store initializers MUST only validate the ready marker and MUST NOT execute migration callbacks, persistent journal-mode changes or legacy file moves.
- Human-bridge state and the PR publication journal MUST use the same opening guard and schema ownership. Daemon bootstrap MUST prepare bridge and publication schemas; channels MUST validate them without running DDL. Cached bridge handles MUST remain bound to the selected state path.
- Channel startup MUST validate every required store before connecting to NATS or serving channels. Missing markers, missing files or a different package version MUST fail once with `STATE_SCHEMA_NOT_READY` and instructions to start the daemon first using the same release. No silent retry or unbounded wait.
- No new confirmation flag, launcher variable, environment classification or configuration-before-release step is required. A legitimate installed daemon MUST retain access based on its process identity.
- Fixture cleanup MUST restore the enclosing `RAVI_STATE_DIR`, including absence. This repair is independent of the opening guard.
- Symlink aliases, dangling links and legacy default DB paths MUST be protected. Hardlinked databases MUST be refused because SQLite WAL identity is path-based.
- This is an accident boundary, not an OS sandbox against code with full filesystem access. New unguarded constructors MUST be rejected in review.

## Publication on the live host

- The live host MUST NOT run complete builds/suites or install dependencies in a new worktree as a prerequisite for publication.
- `ravi pr publish`, governed by `cli/pr`, is the canonical Git Data API path. Preview is the default; `--execute` requires clean committed work. Focused tests and the spec/coverage gate MUST run separately in isolated state before publication.
- Uploaded Git object hashes, tree and commit SHA MUST match the local objects. Published history MUST remain a fast-forward update with `force: false`; no snapshot substitute, release-branch write or hook bypass is permitted.
- Complete build, typecheck, lint, tests and generated-contract checks MUST run in PR CI. Publication does not mean validated; merge still requires green CI and operator instruction.
- Hooks MUST NOT be disabled to publish, including `git -c core.hooksPath=/dev/null push`. Unchanged persistent config does not make per-command bypass compliant.

## Failure patterns

Missing development/real-state boundaries turn convenience into state corruption: cleanup can remove an initial sandbox and lazy initialization can run unreleased migrations on real data. The caller's process role must be checked at the actual opening boundary.

An impossible hook creates a culture of bypass. The sanctioned lightweight publisher makes the allowed path explicit while keeping full validation in CI.
