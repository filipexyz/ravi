---
id: quality/ci-gates
title: "CI Quality Gates Checks"
kind: capability
domain: quality
capability: ci-gates
status: active
---

# CI Quality Gates Checks

## npm Release Authentication Checks

- `bun test src/ci/npm-release-workflows.test.ts src/ci/pre-push.test.ts` executes the release shell steps with fake registry commands and isolated state: no-token publish/dist-tag, optional token fallback logging, nonzero authentication failures, job permissions, Node/npm selection and SDK state isolation.
- `actionlint .github/workflows/*.yml` validates the release workflows.
- Package owners follow the exact npmjs.com configuration in `CONTRIBUTING.md`; both packages require their own workflow filename and direct-publish/dist-tag allowed actions. PR validation MUST NOT publish a package, dispatch a release or change package trust/secrets.

## Quality Gate Aggregator Checks

- `bun test src/ci/quality-gate-shards.test.ts` fails when `test` is not exactly the sequence of `test:shard-N` scripts, when a shard script is not run by CI, or when a segment appears in two shards.
- The same test fails when the job named `Quality Gate` loses `if: always()`, drops a `needs` entry, is renamed, or stops requiring `success` from every dependency (failed, cancelled and skipped all fail it).
- A new CI job that is neither gated nor listed as deliberately not gated fails the same test until someone decides.

## Test Discovery Checks

- `bun test src/ci/test-discovery.test.ts` fails when a test file is selected by no CI command and is not in `src/ci/test-discovery-exclusions.ts`, naming the file and where to add it.
- The same test fails when an exclusion names a file that no longer exists, when CI runs an excluded file, when an exclusion has no reason (fewer than 40 characters), and when an exclusion that says it is run by a package script (`runBy`) is not selected by that script.
- The same test fails when a filter in a CI command selects no test file, for example a path left behind by a rename. Bun does not: it runs the command as long as one filter matches.
- The same test fails on a CI command it cannot read: a wrapped `bun`, a substitution or redirection in a `bun test` command, an unknown `bun test` flag, a glob that matches no test file, a `bun run` of a script that does not exist, or a test command in a step with `working-directory`.
- The same test runs the real `bun test` over stub files for every filter shape in use (substring, `./dir`, `./file`, absolute path, a filter nothing matches next to one that matches) and fails when Bun and the model disagree.
- Dropping `src/cli/media-send.test.ts` from every shard, adding `src/zzz/new.test.ts` without a shard path, or renaming a directory a filter names makes that test fail.

## Spec Gate Checks

- `ravi specs sync --json` succeeds for the full spec tree including `quality/ci-gates`.
- `ravi specs get quality/ci-gates --mode full --json` returns a valid spec with `kind: capability` and all four companion files.
- `ravi specs get quality/ci-gates --mode checks --json` returns this file.
- A three-level spec declaring `kind: capability` instead of `kind: feature` fails the gate with a clear error naming the spec id and expected kind.
- A spec with `id` not matching its directory path fails with a clear mismatch error.

## Coverage Gate Checks

- A diff containing `src/channels/**` without a mapped health, runner, or Socket Mode test fails with a message naming the expected channel coverage.
- A diff containing `src/channels/**` and at least one mapped focused channel test passes the coverage gate.
- Slack thread lifecycle/health store changes with `src/channels/slack/thread-turn-health.test.ts` in the diff pass channel coverage; the same changes without a mapped test fail.
- A diff containing `src/omni/consumer.ts` without a corresponding test file in the diff fails with a message naming the expected coverage, even if the test file exists on disk.
- A diff containing `src/omni/consumer.ts` and `src/omni/consumer-context.test.ts` passes the coverage gate.
- A docs-only diff (`docs/**` or `.ravi/specs/**` only) skips the coverage gate but still runs spec validation.

## CI Integration Checks

- Two consecutive CI attempts on the same commit MUST pass `Test Swift SDK` and log the pinned Swift version; a missing toolchain MUST fail rather than skip.
- `bun test src/ci/pre-push.test.ts` executes both workflows' early isolation steps in a temporary runner directory, loads the resulting `$GITHUB_ENV`, and executes the real pre-push hook with a checker that asserts every check inherits that state. Missing/late setup or a shell export without persistence fails the regression.
- `actionlint .github/workflows/*.yml` exits zero with no diagnostics. YAML parsing alone is not validation of GitHub Actions expression contexts.
- A release run after the final `dev` CI succeeds must push its version tag, finish Version And Publish successfully, and expose that version as `ravi.bot@next` in the npm registry.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/tasks/` passes
  with observer, checkpoint and thread-core suites in the same process.
- Each of `observer.test.ts` and `checkpoint-runner.test.ts`, run alone in a
  fresh test process, imports the real runtime prompt subscription and preserves session-stream
  exports required by `RuntimePromptSubscription` (`SESSION_STREAM`,
  `SESSION_SUBJECT_FILTER`, `getConsumerName` and infrastructure helpers).
- `bun test --timeout 20000 --preload ./src/test/isolated-runtime-preload.ts src/runtime/session-dispatcher.test.ts` passes and is selected by `test:runtime-host`.
- Replacing fixture cleanup with the former unconditional removal of
  `RAVI_STATE_DIR` makes that command fail with `TEST_PRODUCTION_DB_BLOCKED`
  before opening any production database; catching the exception in a test
  cannot hide the failure from the preload's final assertion.

- A pull request targeting a feature branch starts the same Quality Gate as a pull request targeting `main` or `dev`.
- `.github/workflows/ci.yml` includes a step that runs spec validation for PRs.
- `.ravi/specs/**` is not excluded from CI via `paths-ignore` for pull_request events.
- The gate runs without Notion, Devin, or external API secrets.
