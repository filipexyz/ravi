---
id: runtime/signals/why
title: "Why Signals"
kind: why
domain: runtime
capability: signals
status: active
normative: false
---

# Why Signals

## Problem

Ravi has two time modes. In reactive mode the operator speaks and the agent answers. In proactive mode cron, triggers, and heartbeats wake an agent on a schedule.

Neither mode represents "the world changed and nobody is talking."

Today the gap is covered by the heartbeat: an agent wakes periodically, inspects state, and reports. That is expensive, noisy, and blind between beats. It also conflates three different things:

- a condition that is true until it stops being true;
- an event that happened once;
- a message that must be said now.

The result is one of two failures: either the agent wakes often enough to be annoying and expensive, or it misses the window and the operator learns about a full disk after lunch.

## Design Choice

Add one durable primitive: the signal.

A signal is a condition with an explicit close rule. It is raised cheaply, stored durably, re-evaluated when a turn actually happens, and delivered by riding along with that turn. Paying for a turn is an exception reserved for old, severe, still-unresolved facts.

The core rules are:

- **piggyback is free**; out-of-band costs a turn;
- **facts and judgments have different authority**;
- **nothing is delivered at raise time**;
- **truth is re-evaluated at render time**, not trusted from the raise text;
- **a signal that cannot close is not a signal**.

## Why Facts and Judgments Are Separate

A fact can be proven by code. It can close deterministically, escalate deterministically, and page without asking a model.

A judgment is an agent's reading of context. It is useful, but it is not evidence. If judgments could page, every confident model output would become an interruption. If judgments could close facts, the model could silence a real disk problem by saying it looked fine.

Separating them lets Ravi be aggressive with facts and conservative with judgments without building two systems.

## Why Piggyback Is the Default

A turn is the expensive unit. Piggyback uses a turn that already exists, so it adds tokens but not time, wake-ups, or provider sessions.

Pure piggyback fails in two ways: nobody speaks for hours, and the model may swallow the block. The correction is not to abandon piggyback; it is to add a timeout escalation and a deterministic line for P0.

## Alternatives Considered

- **Heartbeat-only**: rejected. It wakes an agent to look, pays for a turn every interval, and still has blind windows.
- **Every condition is an inbox item**: rejected as the primary path. Inbox is a human triage surface; it does not solve prompt delivery, closure, or model compliance. It remains a possible projection.
- **Every condition is a trigger event**: rejected. Triggers are for events; they have no open/closed lifecycle, no cooldown across routes, and no notion of a condition that stays true.
- **A new notifier service**: rejected. The runtime already owns queues, barriers, and session delivery. A second notifier would duplicate delivery semantics and break interruption safety.
- **Numeric severity with separate delivery policy**: rejected for v1. One field (`severity` as delivery class) is simpler and prevents "severity 9 but delivery piggyback" ambiguity.
- **Let the model decide what to surface**: rejected. The model is the consumer, not the scheduler. Budget, cooldown, and escalation must be deterministic.

## Tradeoffs

- Signals add a store, a render transform, and a tick loop. That is real surface area.
- A prompt block costs tokens on every turn where it appears.
- Piggyback can be delayed indefinitely if no turn happens; escalation is the mitigation, not a guarantee of instant delivery.
- Facts require probes, which require code and tests. The spike keeps the probe registry tiny on purpose.
- Hard budgets mean some true signals are intentionally not shown. That is the point: attention is the scarce resource.

## Expected Impact

- Fewer heartbeat "check the world" turns.
- Faster awareness of facts that matter (disk, daemon, channel, credentials) without waking agents on a timer.
- Fewer interruptions, because only facts can escalate and only after a timeout.
- A durable answer to "did anyone know about this at 03:00?"
- A clean separation between task state, inbox triage, event triggers, and ambient world state.
