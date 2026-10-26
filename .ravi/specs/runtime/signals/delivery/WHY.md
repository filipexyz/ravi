---
id: runtime/signals/delivery/why
title: "Why Signals Delivery"
kind: why
domain: runtime
capability: signals
feature: delivery
status: active
normative: false
---

# Why Signals Delivery

## Problem

Any notification system eventually faces two opposite failures: it wakes people for everything, or it stays silent when it matters. Pure piggyback is cheap but can be swallowed or delayed forever. Pure out-of-band is reliable but turns every condition into a turn.

## Design Choice

- Piggyback is the default and the only zero-cost route.
- Escalation is a timeout, not a severity label alone.
- Facts can escalate; judgments cannot.
- `page` does not trust the model: a deterministic line is sent through the channel outbound path, and the agent turn is enrichment.
- The surface ledger is shared across routes, and the daily budget is counted from that ledger.

## Why the Prompt Block

The block is part of the user prompt, not the system prompt. The system prompt is cached and should stay stable. The user prompt is already per-turn, so appending a small data region does not invalidate provider cache or create a second turn.

The block is explicitly context-only. It carries facts, close rules, and an ack command; it does not carry orders. The model decides how to speak, subject to the mention policy.

## Why Not Reuse Hooks

`inject_context` is a prompt atom with a delivery barrier. Delivering through it either queues a turn or interrupts one. That is useful for OOB, but it cannot be the piggyback path without defeating the economy. The render transform is the cheaper seam.

## Alternatives Considered

- Rely on `SessionStart` hook only: misses mid-session turns and may not fire per turn.
- Put signals in the system prompt: invalidates cache and makes every turn look different.
- Send a message per signal and let the model summarize: one turn per signal.
- Trust the model to repeat P0: fails exactly when the model is confused or context is tight.
- Per-channel cooldown: guarantees double delivery when piggyback and OOB use different channels.
