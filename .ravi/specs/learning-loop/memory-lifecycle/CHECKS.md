---
domain: learning-loop
capability: memory-lifecycle
status: draft
created: 2026-07-10
owner: ravi-dev
---

# CHECKS — Memory Lifecycle

- A write exceeding the old file cap MUST succeed (the file grows) while the injected prompt section MUST still truncate at the read cap with a marker. (unit + live)
- The lifecycle MUST fire only at or over the threshold and MUST NOT fire below it; the trigger MUST be length-based, never LLM-judged. (unit)
- Classification MUST obey the matrix: a recurring normative entry graduates, a stale/superseded/one-off entry is evicted, and a fresh true fact is kept. (golden-set validates the routing)
- No code path MUST edit AGENTS.md directly; graduation MUST only emit a proposal artifact or task. (grep + integration checks)
- FIFO MUST fire only when the index is still over threshold after graduate and evict, and MUST remove the oldest kept entry by creation date. (unit)
- Eviction MUST move the topic to an archive directory (recoverable) and MUST NOT hard-delete it. (unit)
- Every graduate, evict, and FIFO action MUST carry provenance (date, run, criterion). (unit)
- Driving memory past the trigger end to end MUST produce a graduation proposal, archive the stale topic, and fire FIFO only if still over threshold. (live, validated across at least two iterations)
