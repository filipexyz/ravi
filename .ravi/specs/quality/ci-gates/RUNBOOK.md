---
id: quality/ci-gates
title: "CI Quality Gates Runbook"
kind: capability
domain: quality
capability: ci-gates
status: active
---

# CI Quality Gates Runbook

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
