---
id: runtime/signals/producers/why
title: "Why Signals Producers"
kind: why
domain: runtime
capability: signals
feature: producers
status: active
normative: false
---

# Why Signals Producers

## Problem

If every component can raise anything, the signal store becomes a second event bus with no closure guarantees. If only one component can raise, the feature never covers the real world.

## Design Choice

- One write contract for both species: `ravi signals raise`.
- The species determines the ceiling, not the caller's confidence.
- Code producers prefer probes for continuous conditions and push for discrete transitions.
- Agents may only raise judgments, with evidence and decay.
- Producers never deliver; they only record conditions.

## Why a CLI Contract

The CLI gives external processes, cron shell jobs, and agents the same idempotent surface. It also makes validation and exit codes testable. Internal daemon code may call the service directly, but the CLI remains the observable contract.

## Why Probes Instead of Arbitrary Checks

A probe is a small, read-only, tested function. It can be cached and timed out. Arbitrary shell checks in the turn path are a latency and security risk.

## Alternatives Considered

- Separate `facts raise` and `judgments raise` commands: more explicit, but doubles the surface and invites drift.
- Let agents raise facts: blurs evidence and creates model-owned truth.
- Let producers write rows directly: bypasses validation and ceilings.
- Event triggers for everything: no lifecycle, no closure, no budget.
