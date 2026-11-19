# Package update and managed runtime reconciliation / CHECKS

- `bun test src/cli/commands/update.test.ts` MUST pass.
- A source-update fixture with two online siblings MUST invoke the rebind
  supervisor, replace both PIDs and verify new boot receipts before success.
- This fixture MUST also converge with the actual PM2 7.1.1/7.1.2 version
  warning preceding every `jlist` result. Parser/consumer regressions MUST
  cover status, runtime target, channel settings and channel liveness.
- The real-PM2 launcher regression MUST open existing fixture state after the
  manager's default PID file is removed and preserve its sentinel after package
  replacement. No production state or process manager may be used by the test.
- Every receipt-writing fixture MUST own a disposable state directory, restore
  the caller's `RAVI_STATE_DIR` (including an absent value), and remove its state
  afterward. The managed rebind test MUST pass without an external state override.
- A subprocess regression MUST run the managed rebind test with caller receipts
  already present and prove their contents and directory entries stay unchanged.
- A supervisor exiting zero without replacing processes, a failed runner
  restart, and an unreadable PM2 snapshot MUST each fail the update.
- A supervisor that records a refusal and exits MUST fail the update with the
  refusal's code and message, with its output in
  `<state>/updates/supervisor.log` and only PM2 reads.
- The PM2 read failure MUST retain both the reconciliation error and the
  underlying command failure in the public diagnostic cause.
- `bun test src/runtime-process-identity.test.ts` MUST verify that an actual
  receipt write failure returns false and emits a diagnostic warning with the
  filesystem cause, without logging receipt or environment-file contents.
- `ravi update --no-restart --json` MUST reject the removed bypass flag.
- A stopped sibling MUST remain stopped after the rebind plan executes.
- Runtime warnings MUST name the affected process and explicit reconciliation
  command without claiming disk version is the live version.
- `bun test src/daemon-stdin.test.ts src/pm2.test.ts` MUST cover package
  replacement, paths containing `bun`, spaces and quotes, forced standby
  registration that preserves the predecessor, and explicit
  clearing of context inherited from the PM2 manager. The real-PM2 fixture MUST
  run both daemon and channels launchers, assert every denied context key is
  absent in the application environment while PM2 retains empty tombstones,
  and verify channels registration and application argv match the state boundary.
  It MUST execute a copied Bun binary under a directory with spaces and quotes,
  with the installed package cwd preserved. A filename collision MUST fail
  before the existing runner is deleted. PM2 name/namespace collisions MUST
  also fail before rebind mutations and preserve unrelated process PIDs.
- `daemon start --json` MUST launch with the same Bun executable and cleared
  runtime/session environment as text mode; quiet lifecycle execution MUST NOT
  depend on launcher variables already existing in the caller environment.
- `bun test src/cli/operator-runtime.test.ts src/cli/registry-operator-gateway.test.ts`
  MUST prove that installed operator commands run in the terminal with the
  daemon's gateway up or down, and that runtime contexts cannot obtain an
  offline operator fallback. Local recovery MUST not initialize real state.
- `bun test src/cli/commands/daemon-restart-supervision.test.ts` MUST prove that
  failed pre-cutover startup preserves the predecessor and that intake stops
  before ownership transfers. Post-cutover recovery MUST verify readiness.
- Rebind tests MUST delay daemon readiness and prove channels have not started;
  missing readiness or a wrong process incarnation MUST fail the update.
- Simulated rebind starts MUST follow the target bundle's observed filesystem
  timestamp, independently of wall-clock precision or skew. Boot observations
  MUST use the same fixture clock as PM2 start times. Replacement tests MUST
  prove the replacement receipt is valid before testing incarnation rejection.
- `bun test src/cli/update-run.test.ts src/cli/commands/update-detach.test.ts`
  MUST prove:
  - the execution decision (handoff inside the tree, markers before the tree
    check);
  - run ids validated before use as paths;
  - a detached environment without runtime context and with an absolute state
    directory; a relative `RAVI_STATE_DIR` anchored at the daemon's cwd (not
    the caller's) for the environment and the run directory, and refused when
    that cwd is unknown;
  - an unreadable PM2 that refuses with `UPDATE_FAILED` before anything is
    detached, installed or stopped, a usage error that still comes first, and
    a worker that counts a failed read during its wait as still inside;
  - every `ravi` registration tested for ancestry; an unreadable, looping or
    too deep ancestry refused in strict mode; the `/proc/<pid>/stat` parser,
    and on Linux the parent read from `/proc` with no `ps` in `PATH`;
  - the saved channel read from the run's resolved state directory (relative
    `RAVI_STATE_DIR` included) and passed to the worker;
  - messages written to `result.json` (worker failure, failed worker launch)
    redacted like the CLI's output;
  - a caller inside the tree that installs nothing and returns the run;
  - refusal when the child cannot start, including a launch failure reported
    as an `error` event by the real spawn (missing executable or working
    directory);
  - a usage error reported to the caller;
  - a child that starts the worker and exits;
  - a worker still inside the tree that refuses and records the result;
  - a worker that removes its run markers before installing, PM2
    registrations that clear them, and an inline update with an inherited run
    id that leaves that run's result alone;
  - a supervisor that refuses before reading its request, also when it cannot
    read PM2, with the reason in `supervisor-refused.json`.
- `bun test src/update-preflight.test.ts` MUST prove:
  - numeric release order, ignoring a prerelease suffix or a `v` prefix;
  - the release that last prepared the state, read from its readiness markers,
    and null without a database or markers;
  - the waypoint refusal for a pre-fence state from a release older than
    3.261113.2 or without markers, with the exact commands, and no refusal for
    a fenced state or one prepared by the waypoint or later, and checkout steps
    instead of `--version` for a source checkout (quoted path, `fetch --tags`,
    `daemon restart -m`);
  - a supervisor that refuses such a state before any stop, records the
    refusal, and consumes its request and budget variables;
  - the stability window: success when the same processes stay online,
    failure on a new PID or start time or a runtime that stops converging, slow
    PM2 reads counted inside the window, a window bounded by the CLI's
    deadline, and no window when the CLI declares no budget;
  - the window wired into the real rebind (fake PM2 and clock): held for its
    length, failed by a daemon or runner restart or a daemon leaving ready,
    ended by the CLI's deadline, and skipped for a CLI that declares no budget
    (3.261113.2 waits 30 s); the supervisor entry passing that plan to the
    rebind;
  - a refusal read back only when recorded since the supervisor started, and
    its code kept only when it looks like one.
