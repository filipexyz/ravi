---
id: memory
title: "Memory Curation Checks"
kind: domain
domain: memory
status: draft
---

# Memory Curation Checks

## Spec Checks

```bash
ravi specs get memory --mode full --json
ravi specs sync --json
```

## Test Suite

```bash
bun test src/memory/
```

MUST be green. Covers the deterministic guard end to end:

- `curate.test.ts` — R3 cap, R9 injection wrap-at-write, R9b secret redact +
  credential-only rejection, R10 drift refusal + `.bak`, R26 cold-start.
- `curate-e2e.test.ts` — SQL delta read → guard write → watermark advance across
  two cadence cycles (cycle 2 reads only the new rows).
- `evict.test.ts` — deterministic FIFO eviction.
- `prompt-section.test.ts` — R6 frozen snapshot, R13 read cap + freshness.
- `watermark-commit.test.ts` — monotonic, done-only advance.
- `scan-injection.test.ts` / `scan-secret.test.ts` — pattern coverage.

## Invariant Checks

- **R6 frozen** — the injected snapshot is captured at prompt build; mid-turn writes
  hit disk but do not retro-mutate the assembled prompt.
- **R9 keep-visible** — injection patterns land on disk wrapped in `[BLOCKED:...]`.
- **R9b redact-at-source** — a credential-only candidate is rejected and never
  written; other secrets are redacted before the write.
- **R10 atomic + drift** — an externally-drifted target is not overwritten; a `.bak`
  is dropped.
- **Cold-start (R26)** — no `MEMORY.md` yields no prompt section and no error.
- **Path confinement** — `ravi memory guard --target` outside a registered agent cwd
  is rejected.

## Operational Check

```bash
ravi memory enroll --all           # idempotent; re-run must not duplicate the hook
ravi memory curate --agent <id>    # task reaches done; telemetry emitted
```
