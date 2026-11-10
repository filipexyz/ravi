# Migration evidence

## 2026-11-10 — issue-less gateway usage errors

- Baseline: `5bac836c` (`origin/dev` at worktree creation). The installed
  `3.261102.1` bundle also contains the reported vocabulary-filter fallback.
- Before the source fix, all three new targeted relay assertions failed:
  real missing-current-chat copy at HTTP 400 and 422, plus preservation of a
  reason containing a redacted token assignment. All became generic rejection.
- Canonical usage errors now use the shared bounded message sanitizer without
  requiring a known phrase. Existing issue-first, unsafe dump/context-key and
  malformed-envelope checks still pass.
- Focused checks: remote relay 115 passed; gateway error contract 20 passed;
  redaction and nine-sink corpus 25 passed; real CLI/gateway permissions
  regression 7 passed. SQLite production-path guard and isolated state active.
- The CLI regression covers `--agent` in JSON/text, unknown profile (400),
  invalid contact (422), missing current chat (400), exact message/code/request
  id/exit parity, and a valid-contact preview without grants.
- The VPS's reported false `CONTACT_NOT_FOUND` is not reproduced on this
  baseline. Source lookup precedes executor planning and uses the canonical id;
  the actual VPS bundle/gateway/state still needs correlation. No production
  contacts, permissions or services were changed.
- Full build, typecheck and complete suite remain in PR CI; no rollout included.
- Independent review found two issues, both fixed: the new suite is selected by
  `test:agent-contract` in a separate guarded process, and the existing single-line
  boundary stays intact so an embedded stack cannot cross as a usage message.

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
