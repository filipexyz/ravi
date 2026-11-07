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
- The canonical managed-runtime launcher generates the admitted channel PM2 registration (`bun <bundle> channels run`). A mismatched PID, name, interpreter, bundle, role, command or additional arguments MUST refuse real-state access.
- CLI, tests, source/build code and linked worktrees refuse the same path even with inherited PM2 env and daemon-looking argv. Explicit isolated state remains usable.
- Refusal occurs before SQLite creates a file or initializes schema. Existing sentinel data/schema survive a refused destructive initializer.
- Symlink aliases, dangling file links, hardlinks and the legacy DB path cannot evade the boundary.
- Original dispatcher recovery cases own isolated fixtures and pass without a harness wrapper.
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
- Checkout documentation separates foreground development from installed PM2 services and requires independent state, broker and credentials. Publication help requires authenticated gateway context; no bare-operator or concurrent-owner guarantee is made.
