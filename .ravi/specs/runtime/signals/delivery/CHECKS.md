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
bun test src/signals/delivery-seam.test.ts
bun test src/runtime/delivery-queue.test.ts -t "signal"
```

## Required Cases

- A turn with no eligible signal MUST render no block.
- A turn with 4 eligible signals MUST render 3 items plus the held line.
- The rendered block MUST stay at or below 1200 characters.
- A piggyback surface MUST NOT create a turn (delta 0).
- A clear rule already true at render time MUST drop the block and resolve the signal.
- Cooldown MUST block a second surface across routes.
- The daily budget MUST be counted from the surface ledger and MUST survive a restart.
- `nudge` MUST use the `after_response` barrier.
- `interrupt` and `page` MUST use the `immediate_interrupt` barrier.
- A judgment signal MUST never produce out-of-band delivery.
- Tick dry-run MUST publish nothing.
- Concurrent ticks MUST escalate at most once.
- `page` MUST send one deterministic line and one prompt sharing one surface row.
- A probe error MUST render `unknown` and MUST NOT page.
- A session outside the signal scope MUST receive no block.

## Trace

`adapter.request` MUST contain:

- `adapter.request` MUST carry `signalsSurfaced` with ids;
- it MUST carry `signalsSkipped` with reasons;
- it MUST record budget used and limit;
- the prompt hash MUST be computed from the augmented prompt.

## Restart

Raise a piggyback signal, restart the daemon before a turn, then run a turn. The surface MUST be created exactly once.

## Regression

After any change to `delivery-queue.ts`, run the full `src/runtime/delivery-queue.test.ts` because the transform sits on the hot path of every turn.
