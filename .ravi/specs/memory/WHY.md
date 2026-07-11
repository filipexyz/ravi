---
id: memory
title: "Memory Curation Rationale"
kind: domain
domain: memory
status: draft
---

# Why Memory Curation Exists

## Problem

Agents accumulate durable facts across turns — user identity, preferences, project
state, corrections — but the model's context window is not durable storage. Without
a curation layer, an agent either re-derives everything each session (expensive,
lossy) or an operator hand-maintains a notes file (does not scale to a fleet).

A naive "let the LLM write its own memory file" approach fails three ways:

- The LLM can inject prompt-override text into its own future context.
- The LLM can leak a secret into a file that is later read back verbatim.
- The LLM can grow the file without bound, or silently stop writing when it fills.

## Design Choice

Split judgment from mechanics. The `curador-memoria` task profile (an LLM) decides
**what** is worth saving. Everything else — scanning, capping, atomic writes, drift
detection, cursor advance, eviction — is a **deterministic runtime guard** that runs
before and after the LLM and cannot be talked out of its invariants.

This mirrors the NousResearch Hermes self-improvement pattern (in-process curator,
reused memory store, deterministic verbs) adapted to Ravi's dispatched-task wiring:
a Stop hook dispatches the curator on cadence, the curator reads only the SQL delta
since the last watermark, and every proposed write is routed through
`applyDeterministicGuard`.

## Consequences

- The curator can be a cheap model (sonnet) because it never owns a safety
  invariant — a compromised or sloppy curator cannot bypass the guard.
- Memory is observable: every cycle emits `ravi.memory.curation.cycle` telemetry.
- Cold-start is a valid state (no `MEMORY.md` → no section, no error), so enrolling
  the whole fleet is idempotent and safe to re-run after every deploy.

## See

- Capability rationale: [[memory/deterministic-loop]] WHY.md
- docs/proposals memory curation PRD
