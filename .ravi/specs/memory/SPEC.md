---
id: memory
title: "Memory Curation"
kind: domain
domain: memory
capabilities:
  - deterministic-loop
tags:
  - memory
  - curation
  - determinism
  - hermes
applies_to:
  - src/memory
  - src/hooks-runtime/actions.ts
  - src/cli/commands/memory.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Memory Curation

## Intent

Persistent per-agent memory (`MEMORY.md` index + `memory/*.md` topic files +
optional `USER.md`) that survives across sessions and is injected — frozen —
into the system prompt at build time.

The domain exists to answer one question deterministically wherever possible:
**what does this agent durably know about its user and environment, and how did
that knowledge get there without corrupting itself over time.**

Memory is NOT: session transcript, task state, skill/procedure knowledge (that
is a skill), normative rule (that is a spec), or dense domain knowledge (that is
the vault). Only facts/state about the user and environment live here.

## Design Lineage

Modeled on NousResearch **Hermes Agent** (`MemoryStore` in `tools/memory_tool.py`,
`hermes_state.py`, `threat_patterns.py`). Adopted verbatim: frozen system-prompt
snapshot, error-on-overflow (no auto-compact), atomic write + drift backup,
injection/secret scan before accept, jitter write-retry under WAL contention.

Both systems curate via a downstream reviewer at cadence 10. The divergence that
creates our determinism gaps is HOW that reviewer is wired:

- **Hermes** forks a quiet review agent in-process after the user-facing turn
  (`nudge_interval`, default 10). The fork inherits the parent's message list,
  provider/model/auth, and reuses the SAME `MemoryStore`. It writes through three
  deterministic verbs (`add`/`replace`/`remove`). There is no materialized
  transcript file and no persisted self-reported cursor — the review position is
  implicit in the live nudge counter and the inherited history.
- **Ravi** dispatches a SEPARATE task on a different model (`curador-memoria`,
  sonnet) that reads a materialized `CURATOR_TRANSCRIPT.md` delta gated by a
  PERSISTED watermark, and writes a free-form candidate blob through
  `ravi memory guard`. The persisted watermark + LLM-reported advance is the
  fragile surface Hermes never has (see `memory/deterministic-loop`).

## Invariants

- Memory MUST be captured into the prompt as a frozen snapshot at build time;
  mid-session writes hit disk but MUST NOT mutate the active prompt (R6).
- Every write MUST pass the deterministic guard (secret scan → injection scan →
  cap check → atomic write + drift) — no code path writes memory files directly.
- Cap overflow MUST error, never silently drop or truncate entries (R3/R11).
- Destructive changes (remove/retire) MUST be HITL-staged, never autonomous (R7).
- Every entry MUST carry absolute-date provenance; relative time expressions are
  corruption across sessions (R16).

## Capabilities

- `memory/deterministic-loop` — the curation loop: how memory is written,
  advanced, capped, and consolidated with the LLM removed from every path a
  deterministic rule can own.

## Validation

- `bun test src/memory` — guard, cap, atomic-write, dedup, curation-state.
- `bun test src/memory/curate-e2e.test.ts` — full ephemeral-session E2E.

## Known Failure Modes

- Slow collapse: read cursor never advances → each cycle re-reads a growing
  transcript. Owned by `memory/deterministic-loop`.
- Silent freeze at cap: consolidation fails repeatedly and memory stops
  updating with no alert. Owned by `memory/deterministic-loop`.
