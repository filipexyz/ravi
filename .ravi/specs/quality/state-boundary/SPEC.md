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
  - src/db/state-readiness.ts
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
- Access to real state MUST be authorized by process role, and there are three:
  - the installed daemon and the installed channel runner: installed runtime code, actual PID registered by PM2, matching executable/arguments and process manager parent;
  - the installed operator CLI: the process entry is the CLI bundle of an installed package, it carries no runtime context (`RAVI_CONTEXT_KEY`, `RAVI_GATEWAY_URL`, `RAVI_SESSION_KEY`, `RAVI_SESSION_NAME`, `RAVI_AGENT_ID`), it is not a `daemon run` / `channels run` entry and it does not run under `NODE_ENV=test`. A test runner is refused by its entry (its test file is not the bundle); the operator's own arguments MAY name anything, a test file included.
  Environment names, inherited `pm_id`, cwd or argv alone MUST NOT authorize it: the operator role rests on where the running code is installed, and a runtime-context variable can only take that role away.
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
- A source checkout, worktree, build or test MUST select isolated state explicitly, normally with `RAVI_STATE_DIR` on the command. Losing that variable MUST refuse real-state access instead of silently opening the default. Errors MUST show the variable, a command example and the installed daemon gateway alternative.
- An installed operator CLI targeting canonical real state MUST run its commands in its own process, on that state: it resolves its credential, authorizes and executes locally, and is not sent to the daemon's gateway. It never prepares a store there: it MUST NOT create a database file, run a store's initialization or migration callback, take a schema lock, change the journal mode or move legacy files. A store that the daemon of the same release has not prepared (missing file, missing marker, marker of another release) MUST be refused with `STATE_SCHEMA_NOT_READY`, reported under that code with the command that fixes it (`ravi daemon restart -m "prepare state"`, or `ravi daemon start` on a first run). Explicit isolated state remains the CLI's own to prepare.
  - For this CLI, real state is `~/.ravi` under `HOME` and under the account's own home (resolved by UID), so a `HOME` override cannot make it the process that prepares the account's real state.
  - What it may still create: feature tables that a module creates on first use inside an already prepared database (`CREATE TABLE` / `CREATE INDEX IF NOT EXISTS`, added columns, the index replacements in `workflow-substrate` and `signals`). Every such path opens the database through the store's `getDb()`, which checks the store's marker for this release first, so the code that runs is the daemon's own release. No such path drops or rebuilds a table; a new lazy path that did MUST move into the store's initialization callback.
- A narrow lifecycle/status path (`daemon` and `channels` `start|stop|restart|status|logs`, `update`) and the credential-file commands MUST work with no database at all, so a stopped or half-updated daemon can be recovered. That path MUST be chosen by the boundary's own view of the operator CLI on real state as well as by the provenance check, so access and recovery never disagree (a `HOME` that is not the account's home, an unavailable account lookup, a state directory inside `~/.ravi`). Runtime contexts and explicit remote invocations MUST NOT gain the local path: a process that carries `RAVI_CONTEXT_KEY` is authorized by the daemon that owns the context and fails closed with `GATEWAY_REQUIRED` when no gateway is reachable.
- Operator transport classification and implicit host gateway discovery MUST resolve the OS account home by the process UID independently of `HOME`, `USERPROFILE` and Bun's environment-sensitive `userInfo().homedir`. A `HOME` override alone MUST NOT promote isolated operator state to real state or redirect runtime gateway discovery. Missing or invalid OS account lookup MUST fail closed; explicit `RAVI_STATE_DIR` remains the selected gateway location.
- Only the installed daemon role may initialize real-state schemas. The operator CLI and the channel runner use what it prepared. Before becoming ready it MUST initialize all runtime stores and record each component's successful initialization for the exact package version. This role boundary does not serialize concurrent daemon processes; see the accepted limitation below.
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

Publication writes the daemon-prepared journal in real state. A Ravi session
publishes through its gateway context; the operator's terminal publishes as the
local operator and names the session that receives the CI follow with
`--reply-session`, which is a destination and grants no authority. The `cli/pr`
contract governs both.

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
- First installation on pre-existing or canonical real state MUST require external verification of accepted-work persistence/completion, closed admissions, disabled legacy launchers and physical exit of both predecessor identities. A synchronous explicit authorization scope MAY adopt that exact database after validating complete inventory, evidence references and physical exits; live or unknown predecessors MUST refuse. The external verifier is trusted coordinator code, never a parser for user claims, environment flags, a stopped record or an empty PM2 result. The production coordinator is the daemon's own entry (see "Thread fence adoption"); missing evidence keeps the daemon from starting. A canonical database that no release wrote (missing, or with no schema object) holds no predecessor work: the daemon entry creates it under `withFreshStateThreadAuthorization` instead, with its own exclusion proof (see "Thread fence adoption"). A synchronous isolated CLI/fixture MAY instead own a private newly-created database, including old schema seeded before fence installation, using the exclusive state constructor; it MUST initialize before sharing the path with another process. Both scopes MUST bind canonical path/device/inode, expire on return, reject async proof and record their reason/evidence before SQL. First fence installation MUST own its commit, never outlive its authorization in an outer transaction.
- Drain receipts MUST state their component scope. Gateway/Slack/outbound completion MUST NOT certify untracked daemon work. Caught callback failures across text/media/upload/file fallback/direct/private sends, actions, metadata, tracing and presence, failed helper results, incomplete receipts and drain timeouts remain unproven; late completion alone MUST NOT erase that outcome. Already-fired presence cleanup/renewal timers MUST remain tracked until settled; clearing scheduled timers alone does not complete their in-flight work.
- Shutdown MUST preserve caught stop/close failures in its result and failure latch, including nested Knowledge runners, database handles, adapter supervisors/subscriptions and final shared-resource cleanup. Each independent sibling stop MUST still be attempted; failed components MUST NOT be reported as stopped or produce exit code zero. Diagnostic failures MUST NOT erase the original failure. Shared storage/broker handles remain open when component completion is unproven. Subscription teardown MUST release idle consumers before awaiting completion and MUST surface rejected cleanup, without changing delivery or retention policy.
- An adapter's terminal command-loop failure MUST survive later stop attempts independently of closed handles. Retrying resource cleanup MUST NOT certify that a failed accepted loop completed successfully; clearing such failure requires an explicit recovery policy outside this preparation.
- Maintenance MUST keep a durable exclusive interlock. Both CLI controls and process entrypoints MUST reject starts/restarts while it exists, including PM2 auto-restarts of prepared binaries. Old binaries require an external launcher interlock; they cannot be assumed to understand the new file.
- Both completions MUST be verified before stopping either process. Stop channels first, then daemon, checking inventories and physical PID absence. Only ESRCH proves absence; EPERM, reused PIDs, replacement processes, failed inventory queries and timeouts MUST keep maintenance blocked. No successor or migration may be authorized by a successful stop command alone.
- Durably queued work, event/destination IDs, receipts and claims MUST survive preparation. Preparation MUST NOT delete queues, reinterpret expiration as non-delivery or retransmit results.
- Canonical JOINs in health/attention (including `thread-attention-admission.ts`) and effective-context provenance for legacy resume/local recovery remain mandatory PR2 gates. PR1 does not implement or certify cross-audience projection.

## Thread fence adoption

- A database with no fence, written by a pre-fence release, MUST be adopted by the daemon of the new release at its own entry (`daemon run`, before the command registry reads `ravi.db`). There is no operator command for it, and none MAY be required: the normal upgrade shows nothing. With the fence present, ordinary restart and update apply and the entry does nothing.
- The entry adopts only as the `ravi` PM2 process running its own bundle, with the `ravi-channels` launcher (if registered) starting that same bundle, no other Ravi daemon online, and a boot receipt of both predecessors. Otherwise it refuses before any write, and every refusal MUST name its next step.
- A pre-fence predecessor cannot close admissions or report completion while alive. For this first adoption only, its proof MUST be collected after physical exit: the channel runner stopped through its launcher, both predecessor identities from their boot receipts exited (ESRCH, or started before the current OS boot), the registry re-read with no relaunch, no replacement and an unchanged bundle, and the durable residue read without opening any store.
- Every accepted unit MUST be terminal, durably pending or durably in flight with a named owner that resumes it in the successor. A status outside the closed rule of its table, an unreadable table, an unreachable broker, non-durable prompts left in memory storage, or in-flight rows with no owner MUST block. Excluded tables MUST be listed with their reason in the evidence.
- The entry MUST take the interlock under the coordinator lease, after the read-only preconditions and before the first stop, and record the adoption first. It claims the successor role for itself and installs the fence inside `withExitedThreadBootstrapAuthorization`, re-verifying database identity, the launcher state and the bundle digest, before any store opens; it records `adopted` and releases the interlock last. The channel runner MUST stay refused until then. Any failure the entry catches before the fence exists MUST release the interlock: nothing was installed, and the next start derives every proof again. A death it cannot catch (SIGKILL, power loss) is covered by the next rule.
- Whoever stops a running channel runner for the upgrade (daemon restart, update, or the entry) MUST first record that intent durably (`runtime-maintenance/channels-after-upgrade.json`). Only a daemon that is ready on a fenced database consumes it: it starts the runner on its own bundle, recreating the registration when it is missing or starts another bundle, and removes the intent only when the start succeeded. A refusal by anyone in between keeps the intent for whichever later start adopts. A runner the operator had stopped has no intent and stays stopped.
- Leftovers of an interrupted adoption (this entry's, or a coordinator's from an earlier release) MUST settle at the entry, and also in `ravi daemon start`, `ravi daemon restart`, `ravi update` and `ravi channels start` before their own interlock check, under the same lease: once the claimed successor has exited, or there is none (a claim left without a recorded successor included), the interlock is released. With the fence installed the adoption is done; without it nothing was installed. Only a successor that may still be running keeps the start refused, and the launcher retries. Settling MUST NOT clear queues, claims, receipts or markers, or touch the database.
- On a pre-fence database the new daemon MUST NOT overlap a legacy writer: `ravi daemon restart` and `ravi update` stop every legacy runtime before it starts, a `ravi` registration on another bundle is replaced rather than restarted, and the entry refuses beside a legacy daemon that is still online. The restart reports success only once the daemon is ready, and says whether the runner came back.
- First start on a new state directory MUST need no operator step and no adoption. A first start is a database no release ever wrote: it does not exist, or it is an SQLite file with no schema object (the file a refused first start leaves). It is not a first start when the write-ahead log holds frames or when the router would move a legacy `~/ravi/ravi.db` in, and a database with any table and no fence never is: the adoption rules above apply to it.
  - `ravi daemon start` reports `fresh` and starts the daemon; nothing else needs to run first.
  - Only the PM2-supervised `ravi` creates the database, at its entry, before any store opens it. Under the coordinator lease, with no interlock and no adoption record, it creates the file with `O_EXCL` (a concurrent creator refuses, and the launcher retries) or takes the empty one, then installs the fence inside `withFreshStateThreadAuthorization`. That scope binds the database identity, refuses any table found at installation, and records `fresh-state-database` with the registrations it saw.
  - The entry knows it is the PM2 `ravi` from a strict PM2 snapshot, read only when PM2 started the process (`pm_id`). An unreadable snapshot refuses; it never passes for the foreground. The ordinary start, on a fenced database, reads nothing from PM2.
  - It refuses, creating nothing, beside another online Ravi process and while a previous runtime that left a boot receipt may still run.
  - A daemon in the foreground (development, on an isolated state directory) creates nothing at the entry and keeps the store path, where an empty isolated database is authorized as `empty-isolated-state`. The state boundary refuses it real state. The PM2 requirement belongs to adopting existing state, not to a first start.
  - A `-wal`, `-shm` or `-journal` entry without its database (any directory entry, a dangling link included) MUST refuse at the entry and in `ravi daemon start`, in every mode, creating nothing: a database created next to it could replay writes without the fence. The refusal names the next step: restore the database next to it, or move the sidecars out of the state directory.
  - Replacement (`ravi daemon restart`, `ravi update`, `ravi channels start`) still refuses a missing database, and names `ravi daemon start` as the next step on a new installation.
- A refused daemon start (the admission check and the entry alike) prints one line and, under PM2, exits after a 30 s pause, so the launcher's restarts do not spin while the refusal waits for its fix. Its reason is kept in `runtime-maintenance/upgrade-failure.json` for the CLI that waits on it; that note is never an authority to act.
- Trust boundary of this proof: the evidence is produced by the runtime's own process and stored in the state directory, so whoever can write that directory can forge it; that power already equals stopping and starting the runtime. The successor re-derives what it can observe (database identity, launcher state, bundle digest, SQLite residue); the broker residue and the exit observations remain the coordinator's record.
