---
id: runtime/delivery-queue/why
title: "Why Runtime Delivery Queue"
kind: why
domain: runtime
capability: delivery-queue
status: draft
normative: false
---

# Why Runtime Delivery Queue

## Problem

Ravi sessions receive more than direct user messages. They also receive cross-session messages, answers, notifications, hooks, triggers, cron jobs, daemon resume notices, observation-plane deliveries, and task reminders.

When one of those external events arrives while the agent is already generating, the wrong default can interrupt the provider turn. The user-visible failure mode is severe: the agent appears to stop mid-action, loses continuity, or never returns to the task it was doing.

## Design Choice

Ravi already has the right primitive: delivery barriers. The fix should strengthen the contract around that primitive instead of adding a second dispatch system.

The core rule is:

- live human input can interrupt after a safe point;
- external/session/system events are `followup` by default;
- active-turn delivery is explicit `steer`;
- immediate interruption is explicit and traceable.

This keeps the runtime predictable while still allowing urgent control messages.

## Why Defaults Matter

Most producers are fire-and-forget. If their default is too aggressive, every integration becomes a potential interrupt source. The safe default for generic external messages is `after_response`, because that preserves the active turn and still guarantees the event becomes the next prompt atom.

`after_response` is the internal barrier behind the operator-facing `followup` lane.

`after_tool` is useful for human conversation and explicit `steer`, but it is too aggressive for generic automation. It can cut a coherent assistant response simply because a notification arrived.

`immediate_interrupt` is useful for urgent correction, cancellation, message edit rebase, or explicit operator intervention. It should not be the accidental default for cross-session chatter.

## Alternatives Considered

- **All events immediate**: fastest delivery, but breaks long-running turns and causes the exact failure this spec addresses.
- **All events after response**: safest for continuity, but makes live human interruption worse.
- **Separate NATS streams per priority**: useful later, but unnecessary while the runtime queue can classify and release prompt atoms deterministically.
- **Provider-native interruption rules**: rejected because provider adapters should not own Ravi session semantics.
- **Prompt-only instruction**: insufficient. The model cannot prevent an event from interrupting the provider turn if the runtime already delivered it aggressively.

## Expected Impact

- Fewer interrupted agent turns from notifications and cross-session messages.
- More reliable task completion when other sessions keep sending updates.
- Clear operator control for urgent messages through explicit immediate delivery.
- Better debugging because queue decisions become visible in trace.
