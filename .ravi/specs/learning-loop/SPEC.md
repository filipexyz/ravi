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

Give every Ravi agent a compounding learning loop adapted from NousResearch Hermes: after turns, the agent reviews the conversation and persists what it learned — facts about the user (MEMORY) and how-to-do-this-class-of-task-for-this-user (SKILLS) — plus a slow background curator that keeps the library from bloating. Learning must run autonomously, driven by the in-process turn loop, without the externalized-state failure modes documented below.

**See:** `/home/ravi/vault-ravi/knowledge/hermes-learning-loop/DA-hermes-learning-loop-core.md`.

## Capabilities

- **memory** (implemented, `src/memory/curation-runtime.ts` + [[memory/deterministic-loop]]): the in-process memory nudge — per-session turn counter in a runtime Map, dispatches a `curador-memoria` task at the interval, writes `MEMORY.md` through the deterministic guard.
- **skill-curation** ([[learning-loop/skill-curation]]): the SKILL half + slow maintenance curator, mirroring the memory pattern.

## Invariants (domain-wide)

- The nudge counter lives IN-PROCESS (a per-session runtime Map), NEVER in a shared/contended DB column (lost-update clobber).
- The runtime dispatches the review curador DIRECTLY in-process at the cadence — no cross-process NATS hook for triggering.
- The review runs ISOLATED (a curador task / ephemeral session), never writing to the parent session (curator-takeover guard).
- The loop NEVER captures environment-dependent failures or negative tool claims ("X is broken") — they harden into self-cited refusals.
- Runtime changes deploy to the daemon's real path (NPM global / `pm_exec_path`), not bun global; verify in the running bundle before validating.

## Validation

- `ravi specs get learning-loop --mode full --json`; `ravi specs sync`.
- Per-capability checks in each capability's CHECKS.md.

## Known Failure Modes

- Lost-update on a shared DB column; cross-process hook not firing; wrong deploy target; curator-takeover; negative-claim hardening. All addressed by the invariants above and detailed in [[learning-loop/skill-curation]].
