---
id: quality/ci-gates
title: "CI Quality Gates Rationale"
kind: capability
domain: quality
capability: ci-gates
status: active
---

# Why CI Quality Gates Exist

## Problem

PR #131 showed that GitHub CI did not validate spec structure. A new three-level spec declared `kind: capability` when depth required `kind: feature`. The error was invisible in CI because:

1. `.ravi/specs/**` was listed in `paths-ignore`, so spec-only changes skipped CI entirely.
2. Even when CI ran, no step executed `ravi specs sync` or `ravi specs get` to catch structural errors.
3. Runtime/consumer changes could merge without corresponding focused tests.

The local pre-push hook caught the error, but only because the developer ran it. CI must be the authoritative gate.

## Design Choice

The gate is deterministic from the diff:

- Extract changed file paths from the PR diff.
- Map `.ravi/specs/**` paths to spec ids by stripping the prefix.
- Map `src/{omni,router,runtime,...}/**` paths to required test coverage.
- Run `ravi specs sync --json` and `ravi specs get <id> --mode full --json` for each changed spec.
- Fail with clear messages naming the spec id, expected kind, and actual kind.

No Notion, Devin, or external API calls. No author/source-based decisions.

## Tradeoffs

- Adding a CI step increases PR check time slightly. Acceptable because spec validation is fast and prevents manual rework.
- Requiring focused tests for runtime paths may block PRs that intentionally skip tests. Mitigated by allowing the test file to exist in the diff or in the test suite already.
- The path mapping is static and must be maintained. Acceptable because the mapped paths change infrequently.

## Release isolation incident, 2026-11-11

Run 42913015466 created the version commit but failed in the pre-push hook
while pushing its tag: seven tests reached the runner's default state and were
correctly refused by `REAL_STATE_ACCESS_REFUSED`. Normal CI supplied an outer
sandbox; the release job did not. This exposed missing fixtures in the bootstrap
provider and follow-maintenance tests. Both fixture ownership and the release
launcher need repair; weakening the storage guard or skipping the hook would
hide the defect. Workflow regressions execute the real hook with cheap checkers
so they can validate inheritance without running full builds on the live host.
