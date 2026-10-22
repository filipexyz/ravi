---
id: runtime/signals/delivery/checks
title: "Signals Delivery Checks"
kind: checks
domain: runtime
capability: signals
feature: delivery
status: active
normative: true
---

# Signals Delivery Checks

```bash
bun test src/signals/render.test.ts
bun test src/signals/tick.test.ts
bun test src/signals/budget.test.ts
bun test src/runtime/delivery-queue.test.ts -t "signal"
```

## Required Cases

- no eligible signal -> no block;
- 4 eligible signals -> 3 items plus held line;
- block length <= 1200 characters;
- piggyback turn count delta is 0;
- clear rule true at render -> no block, state resolved;
- cooldown blocks a second surface across routes;
- daily budget counted from the surface ledger and survives restart;
- `nudge` barrier `after_response`;
- `interrupt`/`page` barrier `immediate_interrupt`;
- judgment never produces OOB;
- tick dry-run publishes nothing;
- concurrent ticks -> one OOB;
- page sends one deterministic line and one prompt, sharing one surface row;
- probe error -> `unknown`, no page;
- session outside scope -> no block.

## Trace

`adapter.request` MUST contain:

- `signalsSurfaced` with ids;
- `signalsSkipped` with reasons;
- budget used and limit;
- prompt hash computed from the augmented prompt.

## Restart

Raise a piggyback signal, restart the daemon before a turn, then run a turn. The surface MUST be created exactly once.

## Regression

After any change to `delivery-queue.ts`, run the full `src/runtime/delivery-queue.test.ts` because the transform sits on the hot path of every turn.
