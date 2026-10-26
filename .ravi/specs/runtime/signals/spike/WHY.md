---
id: runtime/signals/spike/why
title: "Why Signals Spike"
kind: why
domain: runtime
capability: signals
feature: spike
status: draft
normative: false
---

# Why Signals Spike

## Problem

The signals design has several interacting parts: durable state, probes, render injection, budget, escalation, and deterministic page. Building the whole catalog before proving the loop risks a large system that nobody trusts.

## Design Choice

Prove one condition end to end with the hardest delivery requirement: a fact that can page.

Disk free below 15% is:

- measurable by a local, read-only probe;
- operationally real (it already matters to the daemon and to logs);
- naturally hysteretic (open at 15%, clear at 20%);
- safe to fake in tests;
- visibly wrong if Ravi stays silent.

The spike deliberately includes both routes because a piggyback-only spike would pass while the actual failure (nobody spoke) remains untested.

## What the Spike Proves

- the record and close rule can be trusted;
- the render transform does not create turns;
- tick can escalate without duplicate delivery;
- a P0 line can reach the operator without model compliance;
- the budget and cooldown survive restarts.

## What It Does Not Prove

- generic probe loading;
- judgment quality;
- multi-tenant scoping;
- channel breadth;
- that three surfaces per day is the right number.

Those are later decisions, and they should be made with real usage data rather than up front.

## Alternatives Considered

- **Stuck turn instead of disk**: valuable, but harder to fake and currently tangled with the long-tool detach work.
- **Channel offline**: valuable, but requires the channel runner to be stable in the test environment.
- **Piggyback only**: cheaper, but would not test the most important failure mode.
- **Full catalog first**: rejected as scope explosion.
