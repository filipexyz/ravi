---
domain: learning-loop
capability: memory-lifecycle
status: draft
created: 2026-07-10
owner: ravi-dev
---

# WHY — Memory Lifecycle

## The problem this solves
The MEMORY.md index shares one char cap (`DEFAULT_MEMORY_CAP_CHARS = 8192`) between the write side (the file) and the read side (the prompt injection). Once the index fills, new index lines are BLOCKED even though topic files still save — the memory keeps learning but stops surfacing through its index, and consolidation-only (R11) does not free space reliably (observed live at 8076/8192, blocking the index while topic files saved fine).

## Why this shape
- **Decouple caps (L1):** the real constraint is prompt COST (read side), not disk. Bounding only the injection lets the file grow freely, killing the write-block at the root instead of fighting the cap.
- **Graduate/keep/evict (L3-L4):** a filled memory is a signal that some learnings have become PERMANENT (graduate to AGENTS.md), some are still current (keep), and some are dead (evict). A single "trim oldest" (pure FIFO) throws away durable rules and keeps stale noise. The matrix separates value from age.
- **Graduation = HITL (L5):** promoting a memory into AGENTS.md is authoring the agent's own instructions — the same auto-authoring veto that made `main` author the AGENTS.md restructure applies. The lifecycle proposes; it never self-edits.
- **FIFO as tiebreaker only (L6):** determinism where judgment adds no value — when two KEEP entries are equally valid and one must go to fit the budget, "oldest first" is a fair, LLM-free rule. FIFO is the floor, not the policy.
- **Archive not delete (L7):** consistent with skill archive (I14) — retirement must be recoverable; a wrong eviction is restorable.

## Cost of not doing it
The index silently stops accepting new pointers; the agent's newest learnings become undiscoverable through MEMORY.md; consolidation thrash on every over-cap cycle.
