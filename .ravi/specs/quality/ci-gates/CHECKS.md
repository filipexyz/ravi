---
id: quality/ci-gates
title: "CI Quality Gates Checks"
kind: capability
domain: quality
capability: ci-gates
status: active
---

# CI Quality Gates Checks

## Spec Gate Checks

- `ravi specs sync --json` succeeds for the full spec tree including `quality/ci-gates`.
- `ravi specs get quality/ci-gates --mode full --json` returns a valid spec with `kind: capability` and all four companion files.
- `ravi specs get quality/ci-gates --mode checks --json` returns this file.
- A three-level spec declaring `kind: capability` instead of `kind: feature` fails the gate with a clear error naming the spec id and expected kind.
- A spec with `id` not matching its directory path fails with a clear mismatch error.

## Coverage Gate Checks

- A diff containing `src/omni/consumer.ts` without a corresponding test file in the diff fails with a message naming the expected coverage, even if the test file exists on disk.
- A diff containing `src/omni/consumer.ts` and `src/omni/consumer-context.test.ts` passes the coverage gate.
- A docs-only diff (`docs/**` or `.ravi/specs/**` only) skips the coverage gate but still runs spec validation.

## CI Integration Checks

- `.github/workflows/ci.yml` includes a step that runs spec validation for PRs.
- `.ravi/specs/**` is not excluded from CI via `paths-ignore` for pull_request events.
- The gate runs without Notion, Devin, or external API secrets.
