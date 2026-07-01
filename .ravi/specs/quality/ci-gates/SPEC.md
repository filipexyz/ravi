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

- CI MUST run `ravi specs sync --json` for every PR that touches `.ravi/specs/**`.
- CI MUST validate changed specs with `ravi specs get <spec_id> --mode full --json` and `ravi specs get <spec_id> --mode checks --json`.
- CI MUST fail on spec id/path/kind mismatch, invalid frontmatter, missing required companion, or empty/non-verifiable CHECKS for changed specs.
- Runtime/consumer changes MUST include or trigger focused tests.
- Docs-only changes MAY skip runtime coverage but MUST NOT skip spec validation when `.ravi/specs/**` changed.
- The quality gate MUST be deterministic from the diff and path mapping, not from subjective PR author/source judgement.
- Devin-authored deliveries MUST pass the same gate as any PR; if PR touches `src/devin/**`, run existing Devin coverage.
- The gate MUST NOT require Notion, Devin, or other live secrets in CI.
- The spec validation helper MUST extract changed spec ids from the GitHub diff using path prefix stripping on `.ravi/specs/`.
- The focused coverage helper MUST map runtime/consumer paths to their corresponding test files and fail when a mapped path changes without its test file in the diff or test suite.

## Runtime/Consumer Path Mapping

The following source paths are considered runtime/consumer paths that require focused test coverage:

- `src/omni/**`
- `src/router/**`
- `src/runtime/**`
- `src/session-trace/**`
- `src/triggers/**`
- `src/approval/**`
- `src/devin/**`

## Validation

- `bun test src/ci/quality-gate.test.ts`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- A new nested spec at three levels declares `kind: capability` instead of `kind: feature`, passes CI, and fails locally.
- `.ravi/specs/**` changes are excluded from CI via `paths-ignore`, making spec errors invisible.
- A runtime/consumer file changes but no focused test exists or runs, hiding regressions.
- The gate requires external secrets or live APIs, causing CI to fail in forks or offline environments.
