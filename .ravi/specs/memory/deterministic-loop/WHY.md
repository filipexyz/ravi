---
id: memory/deterministic-loop
title: "Deterministic Curation Loop Rationale"
kind: capability
domain: memory
status: draft
---

# Why The Deterministic Loop Exists

## Problem

The memory subsystem was fully wired — Stop hook, `curador-memoria` profile, guard,
incremental watermark — but **inert and unsafe to run autonomously**, because three
runtime-critical steps were still owned by the LLM:

1. **Watermark collapse.** The read cursor advanced only on an id the LLM reported.
   A `proposto=0` cycle (nothing worth saving) left the cursor parked, so the delta
   re-grew every cycle until the whole session was re-read forever.
2. **Unbounded read injection.** The prompt snapshot injected the whole `MEMORY.md`
   with no cap, so a manually-grown store bypassed the write-side budget.
3. **Silent freeze at cap.** When the LLM could not consolidate under cap within its
   attempts, the guard returned a terminal thrash and memory stopped accepting
   writes — with no deterministic fallback.

Net effect: every agent's `MEMORY.md` stayed a cold-start stub; the loop never saved
anything on its own.

## Design Choice

Push the LLM out of every path a deterministic rule can own. Judgment stays with the
curator; mechanics become runtime invariants:

- **P1 — runtime watermark.** The cursor advances in `completeTask` when a
  `curador-memoria` task reaches `done`, regardless of whether anything was saved.
  The LLM-reported id is demoted to a no-op-safe monotonic fallback.
- **P2 — read-side cap + freshness.** The injected snapshot is bounded to the same
  cap the write side enforces (head-preserving truncate-with-marker) and carries a
  freshness marker with the newest absolute date.
- **P3 — deterministic FIFO eviction.** When the curator exhausts
  `consolidationMaxAttempts`, the runtime evicts the oldest `## Diário` rows by
  absolute date until the write fits, then writes and emits `R11:evicted`. If there
  is nothing safe to evict it keeps the honest terminal thrash.

## Consequences

- The loop advances by construction — a lazy or silent curator cannot stall it.
- Cost per cycle is bounded by the delta, not the session length.
- At cap, memory churns deterministically instead of freezing, and the churn is
  observable via the `R11:evicted` counter.

## Out Of Scope (Follow-up)

- **P4 — structured `add/replace/remove` verbs.** Would replace the free-form blob
  append with three deterministic verbs (`old_text` unique-substring match,
  exact-duplicate add = no-op, `remove` HITL-staged per R7). Crosses public command
  shape + profile prompt, so it needs explicit HITL sign-off.
