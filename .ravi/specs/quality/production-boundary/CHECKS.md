---
id: quality/production-boundary
title: "Development and Production Boundary"
kind: capability
domain: quality
capability: production-boundary
status: active
normative: true
---

# Regression checks

```bash
bun test src/router/production-boundary.test.ts src/ci/publish-branch.test.ts src/test/ravi-state.test.ts
bun test src/runtime/session-dispatcher.test.ts -t 'runtime recovery'
RAVI_STATE_DIR="$(mktemp -d)" GITHUB_BASE_REF=dev bun src/ci/run-quality-gate.ts
```

- The cleanup -> missing state -> `getSessionByName` regression uses a fake home in a separate process, never the real production database. It fails against the old cleanup (`HARNESS_STATE_NOT_RESTORED`), and with only cleanup fixed but no opening guard (`UNSAFE_OPEN`).
- Refusal happens before directory/file creation. A fake production database with a sentinel `task_decisions` row retains schema and data when destructive initialization is refused.
- Exact production confirmation permits an installed-release fixture migration; boolean/wrong-root confirmation does not. Test environment or test-file argv rejects even exact confirmation.
- Symlinked roots, symlinked database files and hardlinks cannot evade the guard. A custom production root supplements the default, and a sibling `.ravi-dev` directory stays usable.
- The original runtime recovery cases own isolated fixtures and pass without a harness wrapper.
- Publication tests use disposable Git repositories and a fake API. They cover deletions, binary content, executable/symlink modes, dirty trees, release targets, unrelated bases, existing remote branches and mismatching blobs/trees. Explicit update tests prove parent integration, stale-head refusal, and `force: false`. No external writes occur in tests.
- Full build/typecheck/lint/suite remain in PR CI; the production machine runs only focused checks. `.githooks/**` and shared hook configuration are unchanged.

- PR #766/#767 are the negative publication case: unchanged hook config/files and matching commit/tree hashes do not legalize per-command `core.hooksPath=/dev/null`. Audit the actual publication command as well as the resulting content.

- A subprocess with a fixture installed package opens a fixture production database with confirmation. Without it, the error names `RAVI_CONFIRM_PRODUCTION_STATE_DIR`, BOTH PM2 ecosystem entries, configuration-before-install order and previous-release rollback.
- The same subprocess refuses when run as a test, when `src` marks a source/build checkout, or when `.git` marks a linked worktree, even with confirmation and `daemon run` argv.
