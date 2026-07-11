---
domain: learning-loop
capability: memory-lifecycle
status: draft
created: 2026-07-10
owner: ravi-dev
---

# Memory Lifecycle — bounded MEMORY.md via fill-triggered graduate / keep / evict

## Intent

The per-agent `MEMORY.md` index is character-capped (`DEFAULT_MEMORY_CAP_CHARS = 8192`). Today that cap is enforced on BOTH the write side (the file) and the read side (the prompt injection) with the same constant, so once the index fills, new topic index-lines are BLOCKED even though the topic files themselves were saved — the memory keeps learning but stops being discoverable through its own index.

This capability defines what happens when the index fills: a deterministic-triggered lifecycle that routes each memory entry to one of three destinations — **GRADUATE** (a durable working-rule that should become a permanent AGENTS.md instruction), **KEEP** (a still-current fact/state/preference), or **EVICT** (stale / superseded / one-off / low-value) — with a deterministic FIFO tiebreaker and an HITL gate on graduation.

## Invariants

- **L1. Decouple write-cap from read-cap.** The MEMORY.md FILE may grow past the read budget; only the PROMPT INJECTION stays bounded (the read-side `capToBudget` truncates-with-marker at `DEFAULT_MEMORY_CAP_CHARS`). The index never blocks a write because the file is "full" — file growth is cheap; prompt cost is what must stay bounded. The lifecycle below runs to keep the file HEALTHY and the injected head high-signal, NOT to unblock writes.
- **L2. Deterministic trigger.** The lifecycle fires when the index reaches a threshold fraction of the read cap (default 90% ≈ 7400/8192 chars) — measured by a counter/length, never by LLM judgment. The trigger decides WHEN; the curador decides only WHAT.
- **L3. Three destinations, one classification pass.** Each entry is classified exactly once per run into GRADUATE | KEEP | EVICT. The classification is the curador's judgment, bounded by the L4 criteria; the FIFO tiebreaker (L6) is deterministic.
- **L4. Judgment criteria (the matrix).** An entry is scored on four dimensions:
  - Recurrence: reinforced across ≥2 sessions (durable) vs one-off.
  - Type: a normative working-rule vs a fact/state/preference vs a transient narrative.
  - Generality: general/timeless vs specific-but-current vs obsolete/superseded.
  - Freshness: still true vs stale.
  Decision: `recurring + normative + general → GRADUATE`; `fresh + true + useful → KEEP`; `stale OR superseded OR one-off OR low-value → EVICT`.
- **L5. Graduation is HITL, never auto-applied.** A GRADUATE entry PROPOSES an AGENTS.md change through the agent-spec authoring authority (main / RM approval) — the target agent never self-authors its own AGENTS.md (auto-authoring veto). The lifecycle emits a graduation proposal artifact; it does not edit AGENTS.md.
- **L6. FIFO is the deterministic tiebreaker, not the primary rule.** If the index is STILL over the healthy threshold after graduate+evict, the runtime evicts the OLDEST entries of the KEEP set first (by `created` date), deterministically, until under threshold — the LLM never picks "which one when tied."
- **L7. Evict = archive, never hard-delete (I14 consistency).** An evicted topic file is MOVED to a recoverable `.archive/` (same posture as `ravi skills archive`), never `rm`'d. The index line is removed; the content is restorable.
- **L8. Provenance on every lifecycle action.** Each graduate/evict/FIFO action records date + which run + the criterion that fired, so the lifecycle is auditable (why did X leave?).

## Scope — COMPLETE

- S1. Read/write cap decouple (L1): remove/raise the WRITE cap on the file; keep the READ-side injection cap unchanged.
- S2. Deterministic fill trigger (L2): a length check at curation time; env-overridable threshold.
- S3. Classification pass in the curador prompt (L3/L4): the matrix + decision rule, verbatim, as review instructions.
- S4. Graduation proposal flow (L5): emit an AGENTS.md-change proposal (a task to main / a queued artifact), never auto-edit. Route through the auto-authoring veto.
- S5. Archive + FIFO (L6/L7): evicted topics → recoverable archive; deterministic FIFO tiebreaker in the runtime.
- S6. Provenance + observability (L8): a `ravi memory` inspection surface for lifecycle state (last run, what graduated/kept/evicted, index size vs threshold).

**Deferred:** cross-agent graduation (a rule one agent learns graduating to the FLEET AGENTS.md standard) — a later governance question, not this capability.

## Validation

- L1 proven: a write that would exceed the old file cap SUCCEEDS (file grows); the injected prompt section still truncates at the read cap with a marker.
- E2E: drive an agent's memory past the trigger → the curador classifies real entries → a graduation PROPOSAL lands (not an auto-edit) + an eviction archives a stale topic (recoverable) + FIFO fires only when still over threshold.
- Governance: no path where the lifecycle edits AGENTS.md directly (L5).
