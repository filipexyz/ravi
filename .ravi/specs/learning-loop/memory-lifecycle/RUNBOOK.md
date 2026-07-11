---
domain: learning-loop
capability: memory-lifecycle
status: draft
created: 2026-07-10
owner: ravi-dev
---

# RUNBOOK — Memory Lifecycle

## When it runs
Deterministically, at curation time, when the MEMORY.md index length ≥ threshold (default 90% of `DEFAULT_MEMORY_CAP_CHARS`). Env override: `RAVI_MEMORY_LIFECYCLE_THRESHOLD_PCT`.

## The pass (curador, per run over cap)
1. Read the whole MEMORY.md + topic files (the index is the delta of pointers).
2. Classify each entry via the matrix (recurrence / type / generality / freshness) → GRADUATE | KEEP | EVICT.
3. For each GRADUATE: write a graduation proposal (a task to `main`: "propose adding <rule> to <agent> AGENTS.md") — NEVER edit AGENTS.md here.
4. For each EVICT: `archive` the topic file (recoverable) + drop its index line, stamped with provenance.
5. If the index is STILL ≥ threshold: runtime evicts oldest KEEP entries (FIFO by `created`) until under threshold.
6. Report: proposto=G graduate / K keep / E evict / F fifo, with the criterion per action.

## Inspect
`ravi memory lifecycle status --agent <id> --json` → last run, index size vs threshold, what graduated/kept/evicted, pending graduation proposals.

## Recover a wrong eviction
The archived topic is under the agent's memory `.archive/`; restore by moving it back + re-adding the index line (a `ravi memory restore <slug>` surface, S6).
