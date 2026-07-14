---
id: learning-loop/skill-curation
title: "Skill Curation Learning Loop — Rationale"
kind: capability
domain: learning-loop
status: draft
---

# Skill Curation Learning Loop / WHY

## Problem

Agents forget everything but their raw context. Memory (already built) captures *who the user is*. It does NOT capture *how to do this class of task for this user* — the corrections, pitfalls, and techniques that should make the next session start already-fixed. Without a skill-learning loop, the same corrections recur forever and the agent never compounds.

## Why adapt Hermes (not copy)

NousResearch Hermes solves this with a self-nudge learning loop: after every N turns the agent forks itself in-process and asks "should any skill/memory be saved or updated?", writing skills through its own tools. The intelligence is in the prompt (signals, write-order, guardrails), not the plumbing.

We copy the ARCHITECTURE, not the surface. Hermes forks a Python thread with thread-local context; Ravi agents are separate Node processes. Porting 1:1 is impossible AND unnecessary — the essence is "the agent's own turn loop drives an isolated review that writes durable knowledge." Our adaptation (in-process counter → dispatched curador task) is already proven for the memory half.

## Why the invariants exist (hard-won, same day)

The memory half was rebuilt three times before it worked, because the first designs externalized state that should have stayed in-process:
- A cadence counter in a shared DB column got clobbered every turn by the runtime's own write (lost-update). → I1: counter in-process only.
- A cross-process NATS Stop hook never fired reliably for omni turns. → I2: runtime dispatches directly.
- The fix was deployed to the wrong global (bun vs npm) so it never ran. → deploy-reality note.
These are encoded as invariants so this spec cannot re-birth the broken design.

## Why the negative-capture guardrail is non-negotiable

The single most dangerous failure mode of a learning loop is capturing "X is broken" — it hardens into a self-cited refusal that outlives the actual bug by months. Hermes's prompt forbids it explicitly; so do we (I9). This is the same lesson ravi-dev learned this day (don't harden false constraints).

## See

- `/home/ravi/vault-ravi/knowledge/hermes-learning-loop/DA-hermes-learning-loop-core.md`
- Implemented memory half: `src/memory/curation-runtime.ts`
- Related: [[memory/deterministic-loop]]
