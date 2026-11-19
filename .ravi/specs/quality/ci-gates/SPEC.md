---
id: quality/ci-gates
title: "CI Quality Gates"
kind: capability
domain: quality
capability: ci-gates
tags:
  - quality
  - ci
  - specs
  - testing
  - governance
applies_to:
  - .github/workflows/ci.yml
  - .github/workflows/version.yml
  - .github/workflows/sdk-release.yml
  - .ravi/specs
  - src/specs
  - src/ci
owners:
  - ravi-dev
status: active
normative: true
---

# CI Quality Gates

## Intent

CI quality gates enforce spec and runtime coverage invariants on every PR. The gate prevents spec structural errors and untested runtime/consumer changes from merging, using only the diff, path mapping, and local `ravi specs` commands.

The incident that motivated this capability: PR #131 passed GitHub CI but failed the local mandatory spec gate because a new nested spec `channels/chats/reactions` declared `kind: capability` when its three-segment depth required `kind: feature`. CI did not run spec validation, so the error was invisible until local checks caught it.

## Invariants

- CI MUST run for pull requests targeting any branch, including stacked PRs targeting another feature branch.
- The Swift SDK gate MUST provision an exact Swift toolchain version on a supported runner OS, print `swift --version`, and run the tests without relying on preinstalled Swift or skipping when it is absent.
- CI MUST run `ravi specs sync --json` for every PR that touches `.ravi/specs/**`.
- CI MUST validate changed specs with `ravi specs get <spec_id> --mode full --json` and `ravi specs get <spec_id> --mode checks --json`.
- CI MUST fail on spec id/path/kind mismatch, invalid frontmatter, missing required companion, or empty/non-verifiable CHECKS for changed specs.
- Runtime/consumer changes MUST include or trigger focused tests.
- `Quality Gate` MUST be a final aggregator job named exactly `Quality Gate` with `if: always()` and `needs` on every other gated job (ratchet and policy, build/typecheck/lint, runtime checks, each test shard, Swift SDK). It MUST fail unless every dependency result is `success`, so failed, cancelled and skipped dependencies all fail it. The test shards `test:shard-N` MUST together be exactly `bun run test`; `src/ci/quality-gate-shards.test.ts` enforces both rules.
- Every test file (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` in the checkout) MUST be selected by a CI command or be listed in `src/ci/test-discovery-exclusions.ts` with a reason; a file that CI does not run is a test that does not exist. `src/ci/test-discovery.test.ts` reads the `bun test` commands CI runs (the `run` steps of `.github/workflows/ci.yml`, followed through `bun run <script>`, `for` loops and matrix values) and applies Bun's own selection rule to the file list, so it fails for a file nothing selects, for an exclusion that is stale (the file is gone or CI runs it) or has no reason, and for a filter that selects no file. Bun ignores such a filter while another filter of the same command matches, so without this check a renamed or deleted path silently stops running the tests it named. The test fails closed: a command it cannot read (a wrapped `bun`, a `$(...)`, an unknown `bun test` flag) is an error, never skipped, and it runs the real `bun test` over stub files to confirm that its model of the selection rule still holds.
- Every CI job that runs source commands and the Version And Publish job MUST persist `RAVI_STATE_DIR` under `$RUNNER_TEMP` through `$GITHUB_ENV` before the first source command, so later steps and inherited pre-push hooks share an isolated outer sandbox. `runner` context MUST NOT appear in job-level `env`, where Actions does not allow it. Regression checks MUST execute the setup step, verify its ordering and reject a hook that drops the selection; workflow changes MUST also pass `actionlint`.
- Release verification MUST include successful tag push and npm publication under the intended dist-tag. A successful branch CI or version commit alone does not prove that release succeeded.
- npm release jobs MUST prefer trusted publishing with job-scoped `id-token: write`, a pinned compatible npm CLI, and matching package repository metadata. npm dist-tag operations MUST use npm >=11.21.0 on npm 11 (>=12.2.0 on npm 12) with explicit trusted-publisher dist-tag permission. The existing NPM_TOKEN MAY remain a migration fallback only in the publish step; logs MUST distinguish OIDC exchange success/failure and fallback availability without printing credentials. A missing token MUST NOT skip publication or prevent OIDC. Publish/dist-tag errors, including EOTP, MUST fail the job. Workflow changes MUST NOT configure npm trust, mutate secrets/policies or trigger a release as part of PR validation.
- Tests sharing a Bun process MUST preserve the complete export surface of shared
  modules. Use scoped publisher injection with per-test cleanup when available;
  `mock.restore()` alone MUST NOT be treated as restoration of `mock.module()`.
- The session-dispatcher state-isolation regression MUST run in its own process
  with a disposable outer state directory and a test-only SQLite preload that
  rejects production state paths before opening them. Even a caught rejection
  MUST fail the test run. This harness does not replace the production storage
  access policy.
- The hosted macOS jobs (`Managed runtime launcher / macos-latest` and `Retained preload guard contracts`) are not part of `Quality Gate` and MUST NOT run on `push` to `dev` or `main`: they run for pull requests and `workflow_dispatch`. A hosted macOS runner is sometimes never assigned; the job then sits queued with no runner and no steps and is cancelled after 15 minutes, which turns the run on `dev` red (6 times on 18-19/11/2026, against 15-40 s of work when a runner exists). `Managed runtime launcher` keeps its Linux leg on every event.
- Docs-only changes MAY skip runtime coverage but MUST NOT skip spec validation when `.ravi/specs/**` changed.
- The quality gate MUST be deterministic from the diff and path mapping, not from subjective PR author/source judgement.
- Devin-authored deliveries MUST pass the same gate as any PR; if PR touches `src/devin/**`, run existing Devin coverage.
- The gate MUST NOT require Notion, Devin, or other live secrets in CI.
- The spec validation helper MUST extract changed spec ids from the GitHub diff using path prefix stripping on `.ravi/specs/`.
- The focused coverage helper MUST map runtime/consumer paths to their corresponding test files and fail when a mapped path changes without its test file in the diff.

## Runtime/Consumer Path Mapping

The following source paths are considered runtime/consumer paths that require focused test coverage:

- `src/channels/**`
- `src/omni/**`
- `src/router/**`
- `src/runtime/**`
- `src/session-trace/**`
- `src/triggers/**`
- `src/approval/**`
- `src/devin/**`

High-risk channel lifecycle files MUST also map to their own focused health,
runner, or Socket Mode test so an unrelated channel test cannot satisfy their
coverage requirement.

The focused Slack thread health suite MUST count as channel coverage for thread
health observation, durable attention claims, and publication retry behavior.

## Production-host publication

The production-host publication path is `ravi pr publish`, governed by `cli/pr`; its runtime state access follows `quality/state-boundary`. Before publication, run focused tests and this spec/coverage gate in isolated state without build/full-suite work locally. Full build, typecheck, lint and tests MUST remain in PR CI. An impossible local hook MUST NOT become a reason to disable hooks or waive CI. CI MUST supply isolated state, and test cleanup MUST preserve its enclosing harness directory.

## Validation

- `bun test src/ci/quality-gate.test.ts`
- `bun test src/ci/quality-gate-shards.test.ts`
- `bun test src/ci/test-discovery.test.ts`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- A new nested spec at three levels declares `kind: capability` instead of `kind: feature`, passes CI, and fails locally.
- `.ravi/specs/**` changes are excluded from CI via `paths-ignore`, making spec errors invisible.
- A runtime/consumer file changes but no focused test exists or runs, hiding regressions.
- A test file is added without a path in any `test:shard-N` script, or its path is renamed in the repository but not in the script. CI stays green and the file never runs: 213 of 807 test files, 63 of them under `src/runtime/`, were in that state on 2026-11-18, and some had drifted from the code they test.
- A macOS job queued without a runner is cancelled after exactly 15 minutes and the push run on `dev` ends `failure` although nothing failed and no step ran.
- The gate requires external secrets or live APIs, causing CI to fail in forks or offline environments.
