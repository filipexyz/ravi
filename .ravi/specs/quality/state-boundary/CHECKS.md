---
id: quality/state-boundary
title: "Real State and Process Roles"
kind: capability
domain: quality
capability: state-boundary
status: active
normative: true
---

# Regression checks

```bash
bun test src/db/schema-owner.test.ts src/router/state-boundary.test.ts src/test/ravi-state.test.ts
bun test src/channels/outbound-publish-outbox.test.ts src/channels/slack/automatic-output-circuit.test.ts
bun test src/cloud-agents/chat-routing.test.ts
bun test src/channels/runner-state-boundary.test.ts
bun test src/runtime/session-dispatcher.test.ts -t 'runtime recovery'
RAVI_STATE_DIR="$(mktemp -d)" GITHUB_BASE_REF=dev bun src/ci/run-quality-gate.ts
```

- Fake-home cleanup -> missing state -> `getSessionByName` fails before the guard and passes after it, without touching any real data. PR #768's fixture restoration remains integrated.
- A subprocess representing the installed daemon opens fixture real state with no new env/confirmation flag when its actual PID/entrypoint match the fixture PM2 registry. Missing/mismatching identity refuses actionably.
- `bun test src/daemon-stdin.test.ts` starts a private real PM2, removes only
  its default manager PID file, and launches daemon/channels against an existing
  fixture database through the real guard. Package replacement preserves the
  sentinel data, exact argv, parent PID and registry identity without a PID file.
- `bun test src/router/state-boundary.test.ts` accepts a valid installed PID
  even with the real version banner, and refuses mismatched PID, invalid manager
  PID files and a foreground parent with no PID file despite inherited labels.
- The canonical managed-runtime launcher generates the admitted channel PM2 registration (`bun <bundle> channels run`). A mismatched PID, name, interpreter, bundle, role, command or additional arguments MUST refuse real-state access.
- Tests, source/build code and linked worktrees refuse the same path even with inherited PM2 env and daemon-looking argv, as do a `daemon run` / `channels run` entry PM2 does not supervise and an installed CLI that carries a runtime context. Explicit isolated state remains usable.
- The installed operator CLI MUST open real state the daemon prepared and read and write it, in a unit fixture and as a real launched process; it MUST create no database file, and a script that merely loads the installed package MUST NOT get the role (`bun test src/router/state-boundary.test.ts`).
- On real state the operator CLI MUST refuse a store with no marker or another release's marker with `STATE_SCHEMA_NOT_READY` and `ravi daemon restart -m "prepare state"`, run no initialization callback, take no schema lock and leave the journal mode; on an isolated state directory it MUST prepare the store itself (`bun test src/db/schema-owner.test.ts`). The refusal MUST be reported under its own code with that command, not as an internal failure (`bun test src/cli/agent-contract.test.ts`).
- A `HOME` override MUST NOT make the operator CLI the process that prepares the account's real state, a state directory inside `~/.ravi` MUST count as real state, and an argument that names a test file MUST NOT cost the operator its role (`bun test src/router/state-boundary.test.ts`).
- `bun test src/cli/operator-runtime.test.ts src/cli/registry-operator-gateway.test.ts` verifies that the installed operator's stateful commands run in the terminal, with the daemon's socket up or down, that lifecycle recovery needs no database, and that a runtime context key or an explicit remote gateway never falls back to local execution.
- `bun test src/utils/account-home.test.ts src/cli/operator-runtime.test.ts src/cli/remote-gateway.test.ts` exercises UID-based account lookup and a real Bun subprocess with overridden `HOME`, no inherited `RAVI_STATE_DIR` and no injected `homeDir`: such a process is not the operator on real state, while implicit runtime gateway discovery uses the OS account directory. Unavailable/malformed account lookups fail closed.
- Refusal occurs before SQLite creates a file or initializes schema. Existing sentinel data/schema survive a refused destructive initializer.
- Symlink aliases, dangling file links, hardlinks and the legacy DB path cannot evade the boundary.
- Original dispatcher recovery cases own isolated fixtures and pass without a harness wrapper.
- `src/permissions/runtime-bootstrap-provider.test.ts` and `src/hooks/gh-follow-sweep.test.ts` pass in fresh processes without an inherited `RAVI_STATE_DIR`, and each fixture restores the enclosing selection when one exists.
- `bun test src/ci/pre-push.test.ts` verifies temporary state in CI and release jobs and its propagation through the real pre-push hook, using a lightweight checker instead of running the full suite locally.
- `bun test src/pr/service.test.ts src/pr/journal.test.ts` verifies the canonical publisher and state journal; the complete publication contract is checked by `cli/pr`.
- #766/#767 are the negative publication case: matching trees and unchanged shared config do not legalize per-command hooksPath bypass.
- Full build/typecheck/lint/suite remain in PR CI. Shared `.githooks` and hook config stay untouched.

- Schema-owner regression: channels-before-daemon creates no DB and never connects to NATS; old release markers refuse; complete daemon initialization then channels opening all stores preserves sqlite_master, schema_version and markers exactly while normal queries succeed. Failed initialization cannot leave a ready marker.

- The daemon-to-channel schema snapshot includes nested `human-bridge/bridge.db` and the PR publication tables in `ravi.db`; neither consumer path creates tables or changes markers.
- Source/worktree opens through BridgeStore and the PR publication journal refuse the fake production path before file creation or directory preparation.
- Two isolated handles initialized sequentially for the same component both complete successfully and publish one ready marker. This check does not establish exclusive ownership across concurrent daemon processes; that limitation remains accepted.
- The daemon-to-channel snapshot exercises automatic-output reservation and outbox read/summary/retention APIs. Schema, schema version and markers remain identical; runtime configuration revision, trace-turn identity, thread health and terminal manifest tables remain usable after integration.
- With a ready router but either lazy component marker absent, channel startup refuses before NATS. Direct circuit and outbox APIs also refuse without creating or rebuilding tables.
- Cached statement APIs switch between isolated states without cross-state reads/writes and refuse after state selection is removed.
- Hardlinked legacy database, WAL and SHM sources each refuse before any file moves; all source bytes remain intact.
- Cloud-chat reads/writes refuse an unprepared component in channels. The positive daemon-to-channel schema snapshot reaches `interceptCloudChatMessage` through a synthetic Slack thread message and preserves schema/markers/version.
- Programmatic runner startup, status, detached maintenance and native callbacks retain consumer restrictions without changing unrelated owner work. Consumer marker validation precedes a warmed owner cache, and consumer checks never warm that cache.
- Divergent injected/process state or credential paths refuse before NATS. Canonically equivalent symlink paths remain accepted.
- Checkout documentation separates foreground development from installed PM2 services and requires independent state, broker and credentials. Publication help covers a session's gateway context and the operator's terminal with `--reply-session`; no concurrent-owner guarantee is made.

## Thread preparation checks

- Run focused `schema-fence`, `schema-owner` and `router/state-boundary` fixtures on isolated SQLite, including a cached obsolete connection, concurrent reply/receipt, failed initialization and pending rows. Protocol/frozen rejection precedes readiness changes.
- Run `runtime/work-drain`, `gateway-drain` and touched channel tests: new admissions close synchronously, accepted work completes before DB/NATS close, caught receipt/reconciliation failures and timeouts block proof, durable queue items retain their identifiers.
- Run `runtime-maintenance`: no external verifier means no stop; missing/partial inventory, duplicate PIDs, wrong identity/evidence and enabled legacy launchers refuse; stop success with live/unknown PID remains blocked; replacements preserve the interlock; both exited predecessors are required. Empty isolated state is allowed; canonical real and populated state cannot bootstrap automatically. Run `src/threads/bootstrap-authorization.test.ts`: live legacy refuses without schema mutation; exclusively-created isolated legacy fixture permits and logs its reason; both proven-dead predecessors with complete external evidence permit and log evidence. Missing completion/exclusion/inventory, replacement processes, changed proof/DB inode, another DB, async proof, detached callbacks, failed audit persistence and outer transactions refuse. Run the actual pre-claim receipt upgrade without pre-installing a fence.
- Run `src/threads/fence-adoption.test.ts`, `fence-adoption-residue.test.ts`, `fence-adoption-live.test.ts` and `src/cli/operator-runtime.test.ts` on isolated state: the plan refuses a fenced database, an existing record, missing/duplicate/offline registrations, mismatched boot identity and a predecessor already on the target; the coordinator keeps the interlock on every failure, blocks on relaunch, replacement, unproven exit and unknown residue; only the authorized successor is admitted, once; the fence is installed inside the authorization and the interlock goes last; recovery refuses the wrong mode for the state. Residue counts terminal/pending/in-flight by closed rule, and an unknown status, unreadable table, absent broker or memory-storage prompts block. The maintenance commands run on the offline operator path.
- Verify entrypoint and command guards before schema opening, NATS intake and PM2 mutation. Test update refusal on unprepared state; no fallback suggests independent restarts to bypass the fence.
- Full suite/build/typecheck stay in CI; no production state, package upgrade or restart is part of these tests. PR2 privacy and canonical health JOIN checks remain outstanding.

- `schema-fence-writers.test.ts` scans production source independently of store filenames. Unwrapped protected-table DML, a new unknown store or raw transaction control in protected mutation paths fail the audit; narrow exceptions name their reason. SQL transaction tests separately prove that an old writer cannot borrow an uncommitted lease, even with cached statements, an outer transaction, rollback or process crash.

## PR1 drain and freeze regressions

- A freeze inside an existing transaction, including one opened by its verifier, refuses before granting a lease; a successful freeze is committed and visible from another connection.
- Missing adapter plus failed receipt persistence cannot produce a drain proof, even after NAK. Pending work with a persisted receipt remains eligible for ordinary redelivery.
- A failed gateway drain still attempts the remaining component stops and makes shutdown exit nonzero; shared storage/broker handles are not closed while component completion is unproven.
- Knowledge runner stop and database close failures each retain named original causes, attempt every sibling and yield a blocked shutdown latch/nonzero exit. Only failed Knowledge runners remain active for cleanup retry; a later successful retry never rewrites the original shutdown result.
- A media upload rejection still blocks both gateway drain and the shutdown collector after the delivery handler catches it. A channel-runner close rejection invalidates subsequent drain requests as well as rejecting stop.
- Adapter unsubscribe/supervisor, leadership release, host socket cleanup and subscription teardown failures propagate through their actual stop paths. Idle subscription cancellation completes without a real broker; delayed or rejected cleanup cannot yield an early clean shutdown.
- A failed adapter command loop remains failed on every subsequent stop attempt, even after its handle closed. Retrying handle cleanup cannot certify successful completion of that accepted loop; each later collector result retains the original cause and blocked latch.
- The shared gateway counts caught send failures and in-flight TTS publication without changing payload, send order or retry. Existing Omni/WhatsApp behavior tests run unchanged.
- A drain requested during runner startup cannot certify before startup cleanup or activate later consumers. Successfully stopped drivers leave the active set even if another driver's stop fails.

- Run `src/gateway-drain.test.ts`: rejected media/upload/file fallback, direct send, partial-private send and other action handlers latch failure even when existing catches return normally; captured helper fallback failures also latch while delivery behavior remains unchanged. Both already-fired presence timers remain pending in the tracker: drain waits for delayed success and rejects delayed failure, including an expired parent handler context.
