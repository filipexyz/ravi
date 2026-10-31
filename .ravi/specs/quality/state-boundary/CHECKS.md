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
bun test src/db/schema-owner.test.ts src/router/state-boundary.test.ts src/ci/publish-branch.test.ts src/test/ravi-state.test.ts
bun test src/runtime/session-dispatcher.test.ts -t 'runtime recovery'
RAVI_STATE_DIR="$(mktemp -d)" GITHUB_BASE_REF=dev bun src/ci/run-quality-gate.ts
```

- Fake-home cleanup -> missing state -> `getSessionByName` fails before the guard and passes after it, without touching any real data. PR #768's fixture restoration remains integrated.
- A subprocess representing the installed daemon opens fixture real state with no new env/confirmation flag when its actual PID/entrypoint match the fixture PM2 registry. Missing/mismatching identity refuses actionably.
- CLI, tests, source/build code and linked worktrees refuse the same path even with inherited PM2 env and daemon-looking argv. Explicit isolated state remains usable.
- Refusal occurs before SQLite creates a file or initializes schema. Existing sentinel data/schema survive a refused destructive initializer.
- Symlink aliases, dangling file links, hardlinks and the legacy DB path cannot evade the boundary.
- Original dispatcher recovery cases own isolated fixtures and pass without a harness wrapper.
- Publication tests use disposable Git repos/fake API. Cover binary/deleted/executable/symlink data, dirty trees, forbidden branch targets, unrelated parents, hash mismatches, explicit non-forced updates and stale heads.
- #766/#767 are the negative publication case: matching trees and unchanged shared config do not legalize per-command hooksPath bypass.
- Full build/typecheck/lint/suite remain in PR CI. Shared `.githooks` and hook config stay untouched.

- Schema-owner regression: channels-before-daemon creates no DB and never connects to NATS; old release markers refuse; complete daemon initialization then channels opening all stores preserves sqlite_master, schema_version and markers exactly while normal queries succeed. Failed initialization cannot leave a ready marker.
