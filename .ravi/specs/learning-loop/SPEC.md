---
id: learning-loop
title: "Learning Loop"
kind: domain
domain: learning-loop
capabilities:
  - skill-curation
tags:
  - learning-loop
  - hermes
  - skills
  - memory
applies_to:
  - runtime
  - skills
  - memory
owners:
  - ravi-dev
status: active
normative: true
---

# Learning Loop

## Intent

Give every Ravi agent a compounding learning loop adapted from NousResearch Hermes: after turns, the agent reviews the conversation and persists what it learned — facts about the user (MEMORY) and how-to-do-this-class-of-task-for-this-user (SKILLS) — plus a slow background curator that keeps the library from bloating. Learning runs autonomously from the runtime terminal-turn loop; its phase and cursors survive daemon restarts.

**See:** `/home/ravi/vault-ravi/knowledge/hermes-learning-loop/DA-hermes-learning-loop-core.md`.

## Capabilities

- **memory** (implemented, `src/memory/curation-runtime.ts` + [[memory/deterministic-loop]]): durable per-session cadence dispatches a `curador-memoria` task at the interval and writes `MEMORY.md` through the deterministic guard.
- **skill-curation** ([[learning-loop/skill-curation]]): the SKILL half + slow maintenance curator, mirroring the memory pattern.

## Invariants (domain-wide)

- The cadence transition runs in-process, once for each terminal `complete|interrupted|failed`, and persists a merge-safe namespace in `runtime_session_json`.
- Missing cadence state is phase-aligned from `session_turns`; reconstruction MUST NOT create tasks for historical intervals.
- The runtime dispatches the review curador DIRECTLY in-process at the cadence — no cross-process NATS hook for triggering.
- The review runs ISOLATED (a curador task / ephemeral session), never writing to the parent session (curator-takeover guard).
- Curator/report sessions never tick. An already active or blocked curator suppresses duplicate dispatch for the same origin session.
- Explicit provider quota MUST be a failed runtime terminal and MUST block a task-bound curator; a nominal provider `success` with explicit limit text and zero usage is not `turn.complete`.
- The loop NEVER captures environment-dependent failures or negative tool claims ("X is broken") — they harden into self-cited refusals.
- Runtime changes deploy to the daemon's real path (NPM global / `pm_exec_path`), not bun global; verify in the running bundle before validating.

## Validation

- `ravi specs get learning-loop --mode full --json`; `ravi specs sync`.
- Per-capability checks in each capability's CHECKS.md.

## Known Failure Modes

- Lost-update on a shared DB column; restart phase reset; historical replay; cross-process hook not firing; quota disguised as success; wrong deploy target; curator-takeover; negative-claim hardening. All addressed by the invariants above and detailed in [[learning-loop/skill-curation]].
