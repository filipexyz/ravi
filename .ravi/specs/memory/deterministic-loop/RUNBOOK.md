---
id: memory/deterministic-loop
title: "Deterministic Curation Loop Runbook"
kind: capability
domain: memory
status: draft
---

# Deterministic Curation Loop Runbook

## Trace One Cycle End To End

1. The `memory-curator` Stop hook fires on cadence and dispatches `curador-memoria`.
2. `writeCuratorTranscript` (src/hooks-runtime/actions.ts) materializes only the SQL
   `messages` rows since `lastCuratedMessageId` into `CURATOR_TRANSCRIPT.md`.
3. The curator reads the delta, decides what to save, and calls `ravi memory guard`.
4. `applyDeterministicGuard` runs: R9b secret scan → R9 injection wrap → R3 cap → (on
   overflow past max attempts) FIFO eviction → R10 atomic write → R22 telemetry.
5. On task `done`, `advanceWatermarkForCompletedCuratorTask` moves the cursor —
   even if `proposto=0`.

## Verify P1 (Watermark Advances On Empty Delta)

```bash
ravi memory curate --agent <id>
# task doc should report: proposto=0 ... and the cursor still advances.
```

Watermark state lives in the session's `runtimeSessionParams.memoryCuration
.lastCuratedMessageId`. It only advances on `done`, never on `fail` (at-least-once).

## Verify P2 (Read Cap)

A `MEMORY.md` larger than `DEFAULT_MEMORY_CAP_CHARS` (8192) is injected head-first
with a `[memory truncated at read cap ...]` marker and a `Newest entry: <date>`
freshness line — never injected whole.

## Verify P3 (Eviction)

When consolidation is exhausted and the store has a `## Diário` table, the oldest
rows are evicted by absolute date until the write fits; telemetry carries
`skipReasons["R11:evicted"] = <rows>` with `saved=1`. With no Diário table, the
outcome is the honest terminal `R11:consolidation-thrash`.

## Tuning Knobs

- `--cap-chars <n>` on `ravi memory guard` (default 8192; user store 4096).
- `--consolidation-max-attempts <n>` (default 3) before eviction kicks in.
- `--cadence-turns <n>` on `ravi memory enroll` (default 10, min 2).

## If The Loop Stops Advancing

- Confirm the hook is enabled: `ravi hooks list --json | grep memory-curator`.
- Confirm curador tasks complete `done` (not `fail`) — only `done` advances P1.
- Inspect telemetry topic `ravi.memory.curation.cycle` for `proposed`/`saved`/
  `skipped`/`R11:evicted`.
