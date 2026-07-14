---
id: memory/deterministic-loop
title: "Deterministic Curation Loop"
kind: capability
domain: memory
capabilities:
  - deterministic-loop
tags:
  - memory
  - curation
  - determinism
  - hermes
  - watermark
applies_to:
  - src/memory/curate.ts
  - src/memory/curation-state.ts
  - src/memory/atomic-write.ts
  - src/memory/cap.ts
  - src/memory/dedup.ts
  - src/hooks-runtime/actions.ts
  - src/cli/commands/memory.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Deterministic Curation Loop

## Intent

Push the LLM out of every path a deterministic rule can own. The curator LLM
has exactly ONE irreducible job: decide the *content* of a memory operation
(is this fact worth remembering, and what does it say). Everything else —
which messages to read, whether the write fits, dedup, cap eviction, advancing
the read cursor, drift handling — MUST be owned by deterministic runtime code.

**See:** Hermes `MemoryStore` (`tools/memory_tool.py`). Hermes and Ravi both run
a downstream reviewer at cadence 10 (Hermes `nudge_interval`, Ravi hook
`cadenceTurns`). The difference is wiring: Hermes forks the reviewer IN-PROCESS
(inherits the message list, reuses the same `MemoryStore`, writes via
`add`/`replace`/`remove`), so it needs no materialized transcript and no
persisted cursor — the review position is implicit in the live nudge counter.
Ravi dispatches a SEPARATE task on a different model that reads a materialized
delta gated by a PERSISTED watermark and writes a free-form blob. That persisted
watermark + LLM-reported advance + free-form blob are the three LLM-owned steps
this spec removes; Hermes never had them because its fork sidesteps all three.

## The determinism boundary

```text
DETERMINISTIC (runtime owns — no LLM in path)
  read window      : getMessagesAfterId(sessionName, watermark)
  op application   : add | replace | remove applied to the file
  dedup            : exact-identity reject on write
  secret scan      : R9b — credential-only candidate rejected
  injection scan   : R9  — [BLOCKED:...] wrap, keep-visible
  cap check        : R3  — projected size vs FILE cap, error on overflow
  cap eviction     : oldest-Diário-row eviction to fit (bounded, FIFO)
  atomic write     : R10 — temp+fsync+rename, drift → .bak refuse
  watermark advance: R27 — runtime advances on task completion, not LLM report
  telemetry        : R22 — cycle event emitted best-effort
  freeze snapshot  : R6  — captured once at prompt build

LLM (irreducible judgment ONLY)
  extraction       : what content each add/replace/remove op carries
  supersession     : which existing entry a candidate contradicts (identity_key)
```

## Invariants

### Read cursor (closes pre-mortem #1 + #2)

- The read window MUST be `getMessagesAfterId(sessionName, watermark)` — the
  curator NEVER reads the full session history.
- The watermark (`lastCuratedMessageId`) MUST advance deterministically when the
  curator task COMPLETES for a cycle, driven by runtime, NOT by an LLM-supplied
  `--processed-through-message-id` flag.
- A cycle that reads a non-empty delta and saves nothing (`proposto=0`) MUST
  still advance the watermark: "read and judged not worth saving" is a
  successful cycle, not an unprocessed one. Conflating the two is the root cause
  of slow collapse.
- The watermark MUST be monotonic (`Math.max`) — a later cycle MUST NOT regress
  it below a value a prior cycle committed.
- Advancing the cursor MUST be at-least-once safe: it MUST NOT advance past a
  message the curator never received (a crashed/failed dispatch leaves the
  cursor where it was, so the next cycle re-reads — bounded, never dropped).
- On rollout/cold-start with no trustworthy watermark, the runtime MUST seed the
  cursor at the current latest message id and MUST NOT materialize or dispatch
  the historical backlog. Subsequent cycles read only new rows.

### Write operations (Hermes add/replace/remove)

- The curator MUST express writes as structured ops, not a free-form file blob:
  `add <entry>`, `replace <old_text> <new_text>`, `remove <old_text>`.
- `old_text` for replace/remove MUST match a unique substring across current
  entries; ambiguous match MUST error (deterministic, no guessing).
- Every op MUST route through `applyDeterministicGuard`; no path writes memory
  files directly (Edit/Write allowed only for the curator's own TASK.md log).
- Exact-duplicate `add` MUST be a deterministic no-op success ("no duplicate
  added"), never a second live entry.
- `remove` and any retire/supersede-by-deletion MUST be HITL-staged in
  `_hitl-pending/`, never applied autonomously (R7).

### Cap + consolidation (closes pre-mortem #6)

- A projected write over the file cap (`DEFAULT_MEMORY_FILE_CAP_CHARS`) MUST error deterministically (R3/R11), never
  silently drop.
- Consolidation MUST have a deterministic fallback: when the LLM fails to
  consolidate within `consolidationMaxAttempts` (default 3), the runtime MUST
  evict the oldest Diário rows FIFO to fit the new entry, rather than freezing
  memory silently. Eviction MUST emit a `R11:evicted` telemetry counter.
- Recurring `R11:consolidation-thrash` on the same agent MUST raise a telemetry
  signal (not stay silent) so a frozen-at-cap store is observable.

### Injection READ side (closes design gap #4)

- The prompt-injection READ (`buildMemoryPromptSection`) MUST use the smaller
  `DEFAULT_MEMORY_CAP_CHARS` budget independently from the larger file cap; a
  `MEMORY.md` larger than the read budget MUST be truncated-with-marker, not injected whole.
- Injected memory SHOULD carry a freshness marker (newest entry date) so a
  stale store is visible to the model rather than weighted as current.

## Validation

- `bun test src/memory` — guard, cap, atomic-write, dedup, curation-state.
- `bun test src/memory/curate-e2e.test.ts` — ephemeral session, 2 cadence
  cycles, proves delta-only read + watermark advance + drift-safe cycle 2.
- `bun test src/hooks-runtime/runner.test.ts` — R27 dispatch materializes the
  delta transcript; unresolved-placeholder dispatch is skipped.
- NEW (this spec): a test proving `proposto=0` on a non-empty delta STILL
  advances the watermark (the collapse regression guard).
- NEW (this spec): a test proving deterministic FIFO eviction fires when
  consolidation exhausts its attempts, instead of terminal thrash.

## Known Failure Modes

- **Slow collapse (#1+#2, HIGH):** watermark advances only on `outcome:written`
  via an LLM-reported flag; empty-but-non-trivial cycles never advance it, so
  the delta re-grows every session until something is finally saved. Fix: runtime
  advances on task completion incl. `proposto=0`.
- **Silent freeze at cap (#6, MEDIUM):** consolidation thrash returns terminal
  and recurs every turn with no signal. Fix: deterministic FIFO eviction +
  recurrence telemetry.
- **Unbounded injection (#4, LOW):** READ side has no cap/freshness guard; a
  hand-edited large file bypasses the WRITE cap. Fix: cap+marker on read.
- **Orphan curator tasks (#3, cleanup):** pre-guard dispatches from sessions
  without `agentId` created orphan tasks; the unresolved-placeholder guard now
  skips them at dispatch.
