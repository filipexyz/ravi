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

## Test files that no CI job ran, 2026-11-18

The review of #873 found that `src/jobs/` and the env tests of #871 were in no
shard: the shards are lists of paths, and nothing checked that a test file
appeared in one. Measuring with the real scripts and Bun's real selection rule
(not by grep) found 213 of 807 test files that no CI job ran, 63 of them under
`src/runtime/`. Six had drifted from the code they test while nobody ran them: a
gateway error shape (`{ error: "NotFound" }` became a contract envelope), a
permission now required before a local file is read (`use:tool:Read`), a CLI that
refuses to run in-process when a context key is in the environment, and a
command that now needs Console authentication before its dry-run gate. One more
only passed alone: `server-log.test.ts` shares a module-level throttle with the
other gateway tests, which log real requests through it, and failed as soon as it
ran in the same process (it now owns its keys). Bun does
not help: a filter that matches nothing is ignored as long as another filter of
the same command matches, so a renamed path stops running its tests without a
word. The gate now derives what CI runs from the commands themselves and fails
for a file nothing selects, instead of relying on a person to remember the list.
