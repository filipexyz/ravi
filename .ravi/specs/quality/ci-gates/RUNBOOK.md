---
id: quality/ci-gates
title: "CI Quality Gates Runbook"
kind: capability
domain: quality
capability: ci-gates
status: active
---

# CI Quality Gates Runbook

## When Version And Publish Fails In Git Hooks

Inspect the failing step's commands: `Commit and tag version` also pushes the
tag and branch, so a failure there is not necessarily a pre-commit failure.
`REAL_STATE_ACCESS_REFUSED` from a test means missing fixture/launcher isolation.
Repair both owners; keep the guard and hooks active. Run only the affected
tests and `bun test src/ci/pre-push.test.ts` locally on the production host.
After merge, verify final dev CI, the release run, its remote tag and the npm
`next` version. A green CI or local tag is not a completed release.

## When The Runtime Isolation Regression Fails

Run `bun test --timeout 20000 --preload ./src/test/isolated-runtime-preload.ts src/runtime/session-dispatcher.test.ts`.
`TEST_PRODUCTION_DB_BLOCKED` means a consumer selected the operator state;
the preload threw before opening SQLite. Inspect the first stack and whether
an inner fixture removed the launcher's `RAVI_STATE_DIR`. The final assertion
also reports blocked opens swallowed by recovery code. Fix the isolation; do
not remove the preload or point the test at production to make it pass.

## When A macOS Job Is Cancelled After 15 Minutes

A job `cancelled` at almost exactly 15 minutes with no steps is not a hung test: the hosted macOS runner was never assigned. Confirm with `gh api repos/<repo>/actions/runs/<run_id>/jobs --jq '.jobs[] | [.name, .created_at, .started_at, .completed_at, (.runner_name // "none"), (.steps | length)] | @tsv'`: `runner_name` is empty and `steps` is 0. Re-running the job usually works. Pushes to `dev` and `main` do not run the macOS jobs for this reason; to run them on `dev`, use `workflow_dispatch` on the CI workflow. If a macOS job fails with steps present, that is a real failure: read its log.

## When The Gate Says A Test File Runs In No CI Job

`src/ci/test-discovery.test.ts` lists test files that no CI command selects. Decide for each:

1. It should run in CI: add its path to a `test:shard-N` script in `package.json`. A directory filter such as `src/watch/` also covers files added later, so prefer it when every test under the directory belongs together; where the directory mixes files with different needs (a preload, a process of their own), list the file in the segment of its neighbours. A file that mocks a shared module with `mock.module` gets its own `bun test` segment, because the mock outlives the file. So does a file that only passes alone because it relies on module state other files also touch (a throttle, a cache, a singleton): the first CI run of several files in one process finds it, and the cheaper fix is to give the test keys of its own. Run `bun test src/ci/test-discovery.test.ts` again. Do not run the whole suite on the production host: CI runs the shard.
2. It must not run in CI (a live test that needs real credentials, a retired gate kept as inert material): add it to `src/ci/test-discovery-exclusions.ts` with the reason, and `runBy` when a package script runs it outside CI (`test:live`). A file that fails today is not a reason by itself: fix it, or link the issue that tracks the fix in the reason.
3. The gate also fails for the reverse: an exclusion whose file is gone or that CI runs now (delete the line), and a filter that selects nothing (fix the path or delete it).

To see what CI runs without opening every script, print the model's view:

```bash
bun -e 'import {YAML} from "bun"; import {readFileSync} from "node:fs"; import {collectCiInvocations, listTestFiles} from "./src/ci/test-discovery.ts"; const files = listTestFiles("."); const scripts = JSON.parse(readFileSync("package.json","utf8")).scripts; for (const i of collectCiInvocations(scripts, YAML.parse(readFileSync(".github/workflows/ci.yml","utf8")), files)) console.log(i.origin, "=>", i.filters.join(" ") || i.files.join(" "))'
```

If the test throws on a command it cannot read, teach `src/ci/test-discovery.ts` about the construct (and add a case to its test) instead of rewording the command to dodge it.

## When CI Fails On Spec Validation

1. Read the CI output for the failing spec id and the specific error.
2. Common errors:
   - **kind mismatch**: the spec declares a `kind` that does not match its id depth. Fix the frontmatter `kind` field.
   - **id/path mismatch**: the frontmatter `id` does not match the directory path relative to `.ravi/specs/`. Fix the `id` field or rename the directory.
   - **missing frontmatter**: the `SPEC.md` file lacks a `---` YAML block. Add the required frontmatter.
   - **missing companion**: a required companion file (`WHY.md`, `RUNBOOK.md`, `CHECKS.md`) does not exist. Create it.
3. Run locally to verify:

```bash
bun src/cli/index.ts specs sync --json
bun src/cli/index.ts specs get <spec_id> --mode full --json
bun src/cli/index.ts specs get <spec_id> --mode checks --json
```

4. Push the fix and let CI re-run.

## When CI Fails On Focused Coverage

1. Read the CI output for the runtime/consumer path that changed without test coverage.
2. Either:
   - Add the missing test file to the PR.
   - Confirm the existing test file already covers the changed path and add it to the diff if needed.
3. Push the fix and let CI re-run.

## Adding A New Runtime/Consumer Path Mapping

1. Edit `src/ci/quality-gate.ts` and add the new source path prefix and its expected test pattern to `RUNTIME_PATH_MAP`.
2. Add a test case in `src/ci/quality-gate.test.ts`.
3. Push and verify CI passes.

## Debugging The Gate Locally

```bash
# Simulate the spec gate
bun src/ci/quality-gate.ts specs --diff <list-of-changed-files>

# Simulate the coverage gate
bun src/ci/quality-gate.ts coverage --diff <list-of-changed-files>

# Run the gate tests
bun test src/ci/quality-gate.test.ts
```
