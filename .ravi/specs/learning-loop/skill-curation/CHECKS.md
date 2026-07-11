---
id: learning-loop/skill-curation
title: "Skill Curation Learning Loop — Checks"
kind: capability
domain: learning-loop
status: draft
---

# Skill Curation Learning Loop / CHECKS

## Spec Checks

```bash
ravi specs get learning-loop/skill-curation --mode full --json
ravi specs sync --json
```

## Invariant → Test Map

- **I1 in-process counter** — the skill-nudge counter increments in a runtime Map across ≥3 real turns (1→2→3) and never persists to `runtime_session_json`. Mirror `src/memory/curation-runtime` behavior; validate via the tick log, not a DB read.
- **I2 runtime dispatches directly** — a curador task appears with `createdBy=runtime:skill-nudge` at the interval; no NATS Stop hook involved.
- **I4 isolation (curator-takeover guard)** — integration test: the dispatched review writes to `ravi skills`, NEVER to the parent session message log.
- **I6/I7 prompt fidelity** — the curador profile prompt contains the verbatim Hermes signals + write-order 1→4 + guardrails (grep the profile).
- **I9 negative-capture guardrail** — a session containing an environment failure or "X is broken" claim produces NO skill capturing the negative claim (only a positive fix, if any).
- **I12 lifecycle purity** — `apply_automatic_transitions` moves active→stale→archive with no LLM call.
- **I14 never-delete** — the curator only archives; nothing is hard-deleted.

## E2E Live Check (E.38 — prove across ≥2-3 iterations + full chain)

```bash
# 1. verify the fix is in the RUNNING bundle (daemon's pm_exec_path), not bun global
# 2. drive real turns; watch the counter climb in the log (1→2→3…→interval)
# 3. confirm the skill-curador dispatched (createdBy=runtime:skill-nudge) and completed
# 4. confirm a real SKILL.md patch/create landed and the report fired
```

Never claim "works" from a unit test or a single 0→1 transition (I1/E.38).

## Pilot Metrics (gate before fleet-wide)

reviews/session · `Nothing to save.` vs update ratio · review latency · token cost per fork vs session · RM-rejected false positives. `consolidate` stays OFF until the pilot passes.
