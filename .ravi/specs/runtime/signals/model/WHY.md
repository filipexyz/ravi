---
id: runtime/signals/model/why
title: "Why Signals Model"
kind: why
domain: runtime
capability: signals
feature: model
status: active
normative: false
---

# Why Signals Model

## Problem

A notification without a close rule becomes permanent noise or disappears silently. A condition without identity cannot be deduped, budgeted, or explained.

## Design Choice

- One row per condition, keyed by a stable producer-owned identity.
- One mandatory `clear_when` field. The CLI may default judgments to decay, but the record always carries a resolved rule.
- One small state machine with terminal `resolved` and `expired` distinguished on purpose: resolved means the condition stopped; expired means Ravi stopped carrying it.
- `clear_when` is data with a tiny comparison grammar, never a scripting language.
- Probes are registered code, not configuration.

## Tradeoffs

- Producers must think about closure before raising. That is the point.
- The strict grammar rejects some legitimate predicates (for example, derived ratios). Those become probe fields instead of expression complexity.
- `expired` can look like a false negative. The audit event and close reason make the distinction visible.

## Alternatives Considered

- Free-text `resolved` notes only: impossible to evaluate automatically.
- TTL as the only close rule: every signal becomes a timer and learns nothing about the world.
- Generic expression evaluator: powerful, but a security and determinism liability in the turn path.
- One row per occurrence: defeats dedupe and surface budget.
