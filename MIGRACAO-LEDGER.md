# Migration evidence

## 2026-10-31 — gateway error contract

- Baseline: `caf65661` (`origin/dev` at worktree creation).
- Baseline relay probe: 45 public missing-field envelopes across 28 exposed
  endpoint paths all became the generic remote failure (90 assertions).
- New common boundary: required handler flags produce HTTP 422 / exit 2 /
  VALIDATION_ERROR with field and argument; expected public copy survives;
  internal failures carry a requestId and retain bounded local stack/causes.
- Focused gateway/transport/redaction/SDK tests: 264 passed, 0 failed.
- Focused tasks command tests (separate process because they mock modules):
  54 passed, 0 failed.
- SQLite production-path guard active in test runs; isolated RAVI_STATE_DIR.
- TypeScript, changed-file Biome and spec quality gate checked locally.
- Full build and full suite are deferred to CI. The new spec remains draft
  until the PR head passes CI. No production rollout is included.
- Source map, inventory and operational instructions:
  `.ravi/specs/sdk/gateway/errors/RUNBOOK.md`.
