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
  - src/channels/outbound-publish-outbox.ts
  - src/channels/slack/automatic-output-circuit.ts
  - src/cloud-agents/chat-db.ts
  - src/daemon.ts
  - src/bridge/store.ts
  - src/pr/journal.ts
  - src/router/router-db.ts
  - src/test/ravi-state.ts
  - .github/workflows/ci.yml
  - .github/workflows/version.yml
  - src/permissions/runtime-bootstrap-provider.test.ts
  - src/hooks/gh-follow-sweep.test.ts
---

# Real State and Process Roles

## Invariants

- There is one canonical real state directory (`~/.ravi`) and explicit isolated state directories. "Production environment" is not an authorization role.
- A writable SQLite connection MUST check its target before opening, moving legacy files, creating directories, returning cached handles or initializing schema. Reads through a lazy initializer can also migrate.
- Every writable state constructor MUST use `openStateDatabase`. Pure path display and explicit readonly inspectors MUST NOT initialize schema.
- Cached prepared statements MUST revalidate the selected database through `getDb()` before reuse. Changing isolated state MUST invalidate the old statements; losing state selection MUST refuse instead of reading or writing the old state.
- Legacy migration MUST validate the database and every existing WAL/SHM source before its first rename. A refused hardlink or protected source MUST leave the entire legacy file set unmoved.
- Access to real state MUST be authorized by process role: installed runtime code, actual PID registered by PM2, matching executable/arguments and process manager parent. Environment names, inherited `pm_id`, cwd or argv alone MUST NOT authorize it.
- Identity validation MUST match the canonical launcher for each role: daemon registers the bundle with `daemon run`; channels registers the running Bun executable with `<bundle> channels run`. The exact arguments, bundle and executable MUST be checked; launcher-generated channel registration MUST be covered by regression tests.
- The identity check MUST use the code's location. A package containing `src` or `.git`, unknown code provenance, CLI, build, worktree or test execution MUST NOT gain real-state access by inheriting runtime environment or explicitly naming the real directory.
- Outside the registered runtime, commands MUST select isolated state explicitly, normally with `RAVI_STATE_DIR` on the command. Losing that variable MUST refuse real-state access instead of silently opening the default. Errors MUST show the variable, a command example and the installed daemon gateway alternative.
- An installed operator CLI targeting canonical real state MUST send stateful commands through the existing authenticated gateway, without opening local SQLite for credential resolution or authorization. Explicit isolated state remains local. A narrow local lifecycle/status path MAY use the existing operator provider without databases so a stopped daemon can be recovered; runtime contexts and explicit remote invocations MUST NOT gain that fallback.
- Only the installed daemon role may initialize real-state schemas. Before becoming ready it MUST initialize all runtime stores and record each component's successful initialization for the exact package version. This role boundary does not serialize concurrent daemon processes; see the accepted limitation below.
- The registered installed `ravi-channels` process MAY open existing stores for normal traffic but MUST NOT create, migrate or repair schemas. Its store initializers MUST only validate the ready marker and MUST NOT execute migration callbacks, persistent journal-mode changes or legacy file moves.
- Human-bridge state and the PR publication journal MUST use the same opening guard and schema ownership. Daemon bootstrap MUST prepare bridge and publication schemas; channels MUST validate them without running DDL. Cached bridge handles MUST remain bound to the selected state path.
- Lazy component schemas inside an already guarded database MUST follow the same ownership rule. The daemon MUST prepare cloud-chat bindings/approvals, the outbound publication outbox and Slack automatic-output circuit before readiness; channel preflight MUST validate each component marker. Their normal reads, reservation and retention operations MUST NOT create, rebuild or backfill schema from channels.
- Channel startup MUST validate every required store before connecting to NATS or serving channels. Missing markers, missing files or a different package version MUST fail once with `STATE_SCHEMA_NOT_READY` and instructions to start the daemon first using the same release. No silent retry or unbounded wait.
- Programmatic runners MUST retain schema-consumer restrictions during startup, deferred work, native-host callbacks and status reads, independently of CLI argv. That restriction MUST NOT grant production-state access or demote unrelated owner work in the same process. Consumer validation MUST precede owner initialization caches.
- Channel preflight MUST validate the canonical state and credential paths that the stores actually use. Divergent injected and process paths MUST refuse before NATS; equivalent path aliases MUST remain valid.
- No new confirmation flag, launcher variable, environment classification or configuration-before-release step is required. A legitimate installed daemon MUST retain access based on its process identity.
- Fixture cleanup MUST restore the enclosing `RAVI_STATE_DIR`, including absence. This repair is independent of the opening guard.
- Every test that can reach state, including capability materialization and injected maintenance with remaining default dependencies, MUST create its own isolated fixture. It MUST pass without an enclosing `RAVI_STATE_DIR`; CI isolation MUST NOT conceal missing fixture ownership.
- CI and release jobs that run source checks directly or through Git hooks MUST supply temporary job-scoped `RAVI_STATE_DIR`. The real-state guard MUST remain enforced in CI; missing isolation is a caller defect, not a reason to admit the runner's default state.
- Symlink aliases, dangling links and legacy default DB paths MUST be protected. Hardlinked databases MUST be refused because SQLite WAL identity is path-based.
- This is an accident boundary, not an OS sandbox against code with full filesystem access. New unguarded constructors MUST be rejected in review.

## Known limitations

Schema-owner exclusivity across processes is not provided. Supervised restart can
temporarily register two daemon owners; overlapping initialization can leave a
successful owner's readiness marker beside another owner's partial failed
migration. The single-initializer invalidation is not a cross-process lock or
transaction guarantee. Concurrent migration coordination is a separate workstream.
An outer transaction alone is not a valid repair: existing nested transactions
and foreign-key toggles must be preserved, including avoiding unintended cascades
during `credentials.migrateFileBackend` rebuilds.

Publication against runtime state requires an authenticated gateway context and
daemon journal. A bare operator terminal is unsupported; `--reply-session` does
not authenticate it. The `cli/pr` contract documents this accepted limitation;
no local writable-state fallback or new authority is provided here.

## Publication on the live host

- The live host MUST NOT run complete builds/suites or install dependencies in a new worktree as a prerequisite for publication.
- `ravi pr publish`, governed by `cli/pr`, is the canonical Git Data API path. Preview is the default; `--execute` requires clean committed work. Focused tests and the spec/coverage gate MUST run separately in isolated state before publication.
- Uploaded Git object hashes, tree and commit SHA MUST match the local objects. Published history MUST remain a fast-forward update with `force: false`; no snapshot substitute, release-branch write or hook bypass is permitted.
- Complete build, typecheck, lint, tests and generated-contract checks MUST run in PR CI. Publication does not mean validated; merge still requires green CI and operator instruction.
- Hooks MUST NOT be disabled to publish, including `git -c core.hooksPath=/dev/null push`. Unchanged persistent config does not make per-command bypass compliant.

## Failure patterns

Missing development/real-state boundaries turn convenience into state corruption: cleanup can remove an initial sandbox and lazy initialization can run unreleased migrations on real data. The caller's process role must be checked at the actual opening boundary.

An impossible hook creates a culture of bypass. The sanctioned lightweight publisher makes the allowed path explicit while keeping full validation in CI.
