---
id: memory/deterministic-loop
title: "Deterministic Curation Loop Checks"
kind: capability
domain: memory
status: draft
---

# Deterministic Curation Loop Checks

## Spec Checks

```bash
ravi specs get memory/deterministic-loop --mode full --json
ravi specs sync --json
```

## Test Suite

```bash
bun test src/memory/
```

MUST be green (111 pass / 0 fail at time of writing).

## Invariant → Test Map

- **P1 watermark advances on `proposto=0`** — `watermark-commit.test.ts`
  (proposto=0 over a non-empty delta still advances); `curate-e2e.test.ts`
  (cycle 2 reads only rows after the cursor).
- **P1 monotonic + done-only** — `watermark-commit.test.ts` (never regresses on a
  smaller id; no-op unless `profileId === "curador-memoria"`).
- **P2 read cap truncate-with-marker** — `prompt-section.test.ts`
  (over-cap store keeps the head, drops the tail, carries the truncation marker;
  under-cap store is injected verbatim).
- **P2 freshness marker** — `prompt-section.test.ts` (newest absolute date surfaced;
  no marker when the store carries no date).
- **P3 FIFO by absolute date** — `evict.test.ts` (oldest-first regardless of physical
  order; undated row evicted first; no-Diário-table no-op; frees only what is needed).
- **P3 eviction fallback in the guard** — `curate.test.ts` (consolidation exhausted
  with a Diário table evicts and writes; with no table stays terminal thrash;
  a fitting candidate on a beyond-max attempt still writes).

## Manual / Runtime Check

```bash
ravi memory curate --agent <id>     # forces one cycle
ravi tasks show <task-id> --json     # confirm done + deterministic counts in the doc
```

Expected on an empty delta: `proposto=0 salvo=0 pulado=0 staged=0`, task `done`,
cursor advanced. Expected on a real delta: `MEMORY.md` grows past the cold-start stub.

## Regression Guards

- The effort-resolver default is `medium`; fixtures that assert resolved effort MUST
  use `medium` for a session with no explicit effort (not the old `xhigh`).
- No memory test may depend on `~/.ravi/task-profiles/` — those are the documented
  local-env `src/tasks` failures, unrelated to this capability.
