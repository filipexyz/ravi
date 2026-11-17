# Cron failures and orphan thread closure, 2026-10-31

Read-only production investigation; implementation on an isolated worktree based on dev `caf65661`.
No production configuration changes, replay, daemon restart or merge performed by this workstream.

## Confirmed evidence

| Job | Session / turn | UTC terminal | Evidence |
| --- | --- | --- | --- |
| console-infra-daily (`38fa6efc`) | main / `turn_mvwcn37b_7ur0nj` | 2026-10-31 12:00:36.383Z | dispatched 12:00:12; human after_tool input requests interruption; provider_interrupted |
| Digest de threads (A) (`fab40e38`) | main / `turn_mvwcok43_qe990m` | 2026-10-31 12:02:28.827Z | queued after_response at 12:00:12; starts 12:01:21.363Z; human input interrupts |
| report-dm-matheus-hora (`42ef85c8`) | main-2 / `turn_mvvn452j_lj39dg` | 2026-10-31 00:05:58.212Z | same interrupt pattern, **not** the 12:00Z batch; subsequently disabled by its owner |

Sources: `ravi sessions trace main --since 2026-10-31T11:59:00Z --until 2026-10-31T12:08:00Z --only turn,dispatch --json`; equivalent main-2 trace for 2026-10-30T23:50Z through 2026-10-31T00:15Z. PM2 `ravi-error.log` lines 624405–624419, 624550–624552 and 625055–625057 corroborate main's two cron outcomes. The log uses America/Sao_Paulo, three hours behind UTC.

Both main turns share runtime run `run_mvwcjimh_ibn6ej` across the incident. They were not stopped by restart, timeout or a cron scheduler collision. Dispatcher records `currentTurnReplay=false`; host loop records `startedTool=true`, `materializedOutput=false`, discarding the interrupted atom while preserving successors. Automatic full-prompt replay could duplicate tool side effects.

The runner recorded `lastStatus=error` and logged the event but had no notification path for agent failures. Its shell-only on-error handler depended on another agent prompt. Agent one-shots were deleted after dispatch, before an actual outcome could be recorded.

The same log at 12:00:12Z shows journal launching an incompatible provider/model pair, failing credential selection, then dropping the error response because its delivery account resolved no instance. Deterministic owner delivery avoids both reliance on that model and the broken job reply session. Legacy configuration stays unchanged; repair requires explicit operator action.

The credentials status handler returns a list without an id, while its declared return schema required one `credential`. The gateway therefore raised RETURN_SHAPE_ERROR even though the handler succeeded.

## Added thread evidence

The orchestrator reported five console-infra cards whose child sessions had been pruned, while live-child close worked. The CLI previously required a live child before looking up its lifecycle; it failed before reaching card closure. Regression tests now prune a child and close the durable record, exercising the closed card and idempotency. Command tests also cover denied/missing targets.

The orchestrator also reproduced a cron-created child inheriting Pi with `gpt-6-astra`. Current dev already includes the create-thread provider flag; the installed CLI described by the orchestrator lagged that contract. This fix rejects the known incompatible pair before lifecycle/outbound writes, with a typed, public creation failure. Explicit `--provider codex --model gpt-6-astra` remains valid. This is configuration validation, not a promise that every account can run every custom model; provider availability still belongs to provider preflight.

## Validation boundary

Focused tests use temporary RAVI_STATE_DIR and no inherited runtime authority. No production cron was manually triggered by this workstream. Full build/suite and generated SDK platform checks belong to CI. Publication uses the sanctioned Git Data API path because the local pre-push hook runs the prohibited full build/suite on this production machine; pre-commit remains enabled. Exact publication commands, commit/tree verification and final test counts are recorded in the PR.

Local validation passed: 381 tests across the cron directory and focused model validation/catalog, runtime request builder, agents, sessions, credential status, remote gateway and Slack lifecycle suites; `bun run typecheck`; Biome; TypeScript/Dart/Swift SDK drift checks; both OpenAPI drift checks; spec sync and the quality gate. SDK drift is checked locally; platform compilation and the full build/test suite remain CI checks.
