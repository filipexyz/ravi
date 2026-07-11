---
domain: learning-loop
capability: memory-lifecycle
status: draft
created: 2026-07-10
owner: ravi-dev
---

# CHECKS — Memory Lifecycle

- [ ] L1: a write exceeding the OLD file cap succeeds (file grows); the injected prompt section still truncates at the read cap with the marker. (unit + live)
- [ ] L2: the lifecycle fires ONLY at/over the threshold, never below; trigger is length-based, not LLM. (unit)
- [ ] L4: classification obeys the matrix — a recurring normative general entry GRADUATES; a stale/superseded/one-off EVICTS; a fresh true fact KEEPS. (golden-set)
- [ ] L5: NO code path edits AGENTS.md directly; graduation only emits a proposal artifact/task. (grep + integration)
- [ ] L6: FIFO fires only when still over threshold after graduate+evict, and removes the oldest KEEP by `created`. (unit)
- [ ] L7: eviction MOVES the topic to `.archive/` (recoverable), never hard-deletes. (unit)
- [ ] L8: every graduate/evict/FIFO action carries provenance (date + run + criterion). (unit)
- [ ] E2E: drive memory past trigger → real classification → graduation proposal lands + stale topic archived + FIFO only if still over. (live, ≥2 iterations)
