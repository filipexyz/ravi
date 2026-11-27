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
  - .github/workflows/voice-release.yml
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
- The release jobs (`sdk-release.yml`, `voice-release.yml`, `release.yml`, `version.yml`) MUST run on `ubuntu-24.04`, the image of the test shards, not `ubuntu-latest`: the version bump is pushed with the pre-push hook, which runs the whole suite there. The SDK Release job's `timeout-minutes` MUST cover that suite run in series (shards 1 to 4); it is 45, because 15 cancelled the run of 2026-11-25 (run 45689627783) while the bump step was still running. A push of the version bump declined by the repository rules (the server's own `remote: error: GH013:` or `GH006:` line, never a line of the pre-push log) MUST be a warning, as in `version.yml`: the ruleset of `dev` requires the Quality Gate check on every new commit, and the version comes from npm, not from the file, so the build and publish steps still run. Any other failure of that push, the pre-push suite included, MUST fail the job. An omitted `prefix` MUST NOT move `latest` back to an older major: when the registry's major is ahead of the manifest's (the bump was declined), the registry's major is used.
- `voice-release.yml` publishes `@ravi-os/voice` and MUST mirror `sdk-release.yml`: the same manual trigger and branch input, the same date-based version derived from npm, the same declined-push rule, the same 45-minute limit and the same OIDC publish with provenance and the optional `NPM_TOKEN` fallback. The only differences are that it does not regenerate the SDK client and that it builds the kit against the published floor of its `@ravi-os/sdk` peer range (`>=<version>`), installed with `--no-save` in the package directory, so a published kit compiles with the oldest SDK it accepts.
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
- The hosted macOS jobs (`Managed runtime launcher / macos-latest` and `Retained preload guard contracts`) are not part of `Quality Gate` and MUST NOT run on `push` to `dev` or `main`: they run for pull requests and `workflow_dispatch`. A hosted macOS runner is sometimes never assigned; the job then sits queued with no runner and no steps and is cancelled after 15 minutes, which turns the run on `dev` red (7 macOS jobs in 6 push runs on 18-19/11/2026, runs 44306357454, 44326641831, 44334339070, 44368727360, 44554831108 and 44579877250; the same jobs take 14-40 s when a runner exists). `Managed runtime launcher` keeps its Linux leg on every event.
- **macOS is no longer in front of the `@next` release.** `version.yml` publishes `@next` when the push run of `CI` on `dev` or `main` ends `success`, and until this change that run included both macOS jobs, so a macOS-only regression of the managed runtime launcher (real PM2) or the retained preload guards withheld the release. With macOS off the push, the publication waits for no macOS job, and the production host runs macOS. The macOS coverage before a release is the run of the pull request.
- **Merge rule for macOS.** A pull request that touches the managed runtime launcher or the retained preload guards (`src/daemon-stdin*`, `src/cli/operator-runtime*`, `src/utils/account-home*`, `src/utils/paths*`, `src/managed-runtime*`, `src/pm2*`, `src/runtime-process-identity*`, `src/db/state-boundary*`, `src/threads/schema-fence*`, `src/test/retained-*`, `scripts/test-retained-preload.ts`, `scripts/test-direct-interrupted-retention.ts`, or `.github/workflows/ci.yml`) MUST NOT be merged until `Managed runtime launcher / macos-latest` and `Retained preload guard contracts` are `success` in the run of that pull request. A job `cancelled` with no steps is a missing runner: re-run it. A job that failed with steps blocks the merge even when `Quality Gate` is green. The list follows the source files the tests of those two jobs import that depend on the platform (`src/db/state-boundary*` canonicalizes paths with `realpathSync`, which differs on macOS, `/var` against `/private/var`; `src/utils/paths*` is imported by the launcher and `src/threads/schema-fence*` by `state-boundary`): a pull request that makes a test of either job import another source file that touches paths, processes or the filesystem adds that path here in the same pull request. Neither job is a required check, so this rule is the reviewer's and the merger's to apply.
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
- With one push run per ref held at a time (`concurrency: ci-${{ github.ref }}`, `cancel-in-progress: false` on pushes), a macOS job waiting for a runner held the group, so the next push to `dev` waited up to 15 minutes behind it (run 44581076732 was created at 17:48:16Z and started its jobs at 17:56:54Z, three seconds after the macOS job of the previous run, 44579877250, was cancelled at 17:56:51Z). Pushes without macOS jobs no longer wait on that queue.
- The gate requires external secrets or live APIs, causing CI to fail in forks or offline environments.
