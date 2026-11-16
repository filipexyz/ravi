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
  - src/threads/schema-fence.ts
  - src/threads/bootstrap-authorization.ts
  - src/runtime-maintenance.ts
  - src/runtime/work-drain.ts
  - src/runtime/shutdown.ts
  - src/knowledge/runners.ts
  - src/db/close-all.ts
  - src/adapters/session-adapter-bus.ts
  - src/leader/index.ts
  - src/cli/host-cli-gateway.ts
  - src/cron/runner.ts
  - src/triggers/runner.ts
  - src/work-objects/nats.ts
  - src/nats.ts
  - src/managed-runtime-rebind.ts
  - src/gateway.ts
  - src/db/schema-owner.ts
  - src/db/runtime-state.ts
  - src/channels/runner.ts
  - src/channels/outbound-publish-outbox.ts
  - src/channels/slack/automatic-output-circuit.ts
  - src/channels/slack/automatic-media-output.ts
  - src/channels/slack/text-send.ts
  - src/channels/slack/markdown-delivery.ts
  - src/cloud-agents/chat-db.ts
  - src/daemon.ts
  - src/bridge/store.ts
  - src/pr/journal.ts
  - src/router/router-db.ts
  - src/test/ravi-state.ts
  - src/utils/account-home.ts
  - src/cli/operator-runtime.ts
  - src/cli/remote-gateway.ts
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
- A missing default `PM2_HOME/pm2.pid` MUST NOT by itself refuse an installed
  runtime. Only when that file is absent, the actual live parent's PM2 God
  Daemon title and canonical PM2 home MAY establish supervisor identity before
  querying the registry. A present invalid/unreadable/mismatching PID file
  MUST still refuse. This fallback MUST retain every PID/name/entrypoint/argument
  check and MUST NOT accept inherited PM2 labels or a boot receipt as authority.
- PM2 registry parsing MUST tolerate leading version/diagnostic banners while
  rejecting malformed, truncated or non-array JSON. A failed registry query
  MUST NOT authorize real state or expose the secret-bearing registry output.
- Identity validation MUST match the canonical launcher for each role: daemon registers the bundle with `daemon run`; channels registers the running Bun executable with `<bundle> channels run`. The exact arguments, bundle and executable MUST be checked; launcher-generated channel registration MUST be covered by regression tests.
- The identity check MUST use the code's location. A package containing `src` or `.git`, unknown code provenance, CLI, build, worktree or test execution MUST NOT gain real-state access by inheriting runtime environment or explicitly naming the real directory.
- Outside the registered runtime, commands MUST select isolated state explicitly, normally with `RAVI_STATE_DIR` on the command. Losing that variable MUST refuse real-state access instead of silently opening the default. Errors MUST show the variable, a command example and the installed daemon gateway alternative.
- An installed operator CLI targeting canonical real state MUST send stateful commands through the existing authenticated gateway, without opening local SQLite for credential resolution or authorization. Explicit isolated state remains local. A narrow local lifecycle/status path MAY use the existing operator provider without databases so a stopped daemon can be recovered; runtime contexts and explicit remote invocations MUST NOT gain that fallback.
- Operator transport classification and implicit host gateway discovery MUST resolve the OS account home by the process UID independently of `HOME`, `USERPROFILE` and Bun's environment-sensitive `userInfo().homedir`. A `HOME` override alone MUST NOT promote isolated operator state to real state or redirect runtime gateway discovery. Missing or invalid OS account lookup MUST fail closed; explicit `RAVI_STATE_DIR` remains the selected gateway location.
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

## Thread writer preparation (PR1)

- Both `ravi` and `ravi-channels` write thread lifecycle state. Readiness and schema-owner roles MUST NOT be treated as a writer fence.
- Every current writer MUST present its compiled protocol at the SQL boundary. `runThreadMutation` owns one prepared DML and an uncommitted lease inside `BEGIN IMMEDIATE` or an existing transaction savepoint; it deletes the lease before returning or committing. It accepts no callback, uses no TTL and never executes caller SQL with `exec`. A missing/obsolete writer, including a previously prepared statement on another connection, MUST fail before protected DML or readiness invalidation. Authorization committed by another connection MUST NOT authorize a legacy writer.
- The durable thread fence carries a monotonic protocol floor, phase and epoch. This preparation serves `legacy_ready` only and may freeze writes; it MUST NOT backfill, drop legacy lifecycle state, switch to canonical state or thaw a failed migration.
- First installation on pre-existing or canonical real state MUST require external verification of accepted-work persistence/completion, closed admissions, disabled legacy launchers and physical exit of both predecessor identities. A synchronous explicit authorization scope MAY adopt that exact database after validating complete inventory, evidence references and physical exits; live or unknown predecessors MUST refuse. The external verifier is trusted coordinator code, never a parser for user claims, environment flags, a stopped record or an empty PM2 result. No automatic production coordinator is wired by PR1: missing evidence remains a deployment blocker. A synchronous isolated CLI/fixture MAY instead own a private newly-created database, including old schema seeded before fence installation, using the exclusive state constructor; it MUST initialize before sharing the path with another process. Both scopes MUST bind canonical path/device/inode, expire on return, reject async proof and record their reason/evidence before SQL. First fence installation MUST own its commit, never outlive its authorization in an outer transaction.
- Drain receipts MUST state their component scope. Gateway/Slack/outbound completion MUST NOT certify untracked daemon work. Caught callback failures across text/media/upload/file fallback/direct/private sends, actions, metadata, tracing and presence, failed helper results, incomplete receipts and drain timeouts remain unproven; late completion alone MUST NOT erase that outcome. Already-fired presence cleanup/renewal timers MUST remain tracked until settled; clearing scheduled timers alone does not complete their in-flight work.
- Shutdown MUST preserve caught stop/close failures in its result and failure latch, including nested Knowledge runners, database handles, adapter supervisors/subscriptions and final shared-resource cleanup. Each independent sibling stop MUST still be attempted; failed components MUST NOT be reported as stopped or produce exit code zero. Diagnostic failures MUST NOT erase the original failure. Shared storage/broker handles remain open when component completion is unproven. Subscription teardown MUST release idle consumers before awaiting completion and MUST surface rejected cleanup, without changing delivery or retention policy.
- An adapter's terminal command-loop failure MUST survive later stop attempts independently of closed handles. Retrying resource cleanup MUST NOT certify that a failed accepted loop completed successfully; clearing such failure requires an explicit recovery policy outside this preparation.
- Maintenance MUST keep a durable exclusive interlock. Both CLI controls and process entrypoints MUST reject starts/restarts while it exists, including PM2 auto-restarts of prepared binaries. Old binaries require an external launcher interlock; they cannot be assumed to understand the new file.
- Both completions MUST be verified before stopping either process. Stop channels first, then daemon, checking inventories and physical PID absence. Only ESRCH proves absence; EPERM, reused PIDs, replacement processes, failed inventory queries and timeouts MUST keep maintenance blocked. No successor or migration may be authorized by a successful stop command alone.
- Durably queued work, event/destination IDs, receipts and claims MUST survive preparation. Preparation MUST NOT delete queues, reinterpret expiration as non-delivery or retransmit results.
- Canonical JOINs in health/attention (including `thread-attention-admission.ts`) and effective-context provenance for legacy resume/local recovery remain mandatory PR2 gates. PR1 does not implement or certify cross-audience projection.
