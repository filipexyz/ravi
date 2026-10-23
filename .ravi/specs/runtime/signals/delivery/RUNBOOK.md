---
id: runtime/signals/delivery/runbook
title: "Signals Delivery Runbook"
kind: runbook
domain: runtime
capability: signals
feature: delivery
status: active
normative: true
---

# Signals Delivery Runbook

## Verify Piggyback

1. Raise a test signal with `severity=piggyback`.
2. Confirm zero turns were created.
3. Start any turn in the scoped session.
4. Confirm the block appears in `adapter.request` trace and `signalsSurfaced` is populated.
5. Confirm `surface_count` increased by one and one `signal_surfaces` row exists.

## Verify OOB

```bash
ravi signals tick --json            # dry run: inspect candidates, no sends
ravi signals tick --execute --json  # deliver
```

Check:

- `deliveryBarrier` on the published prompt (`after_response` vs `immediate_interrupt`);
- one surface row per escalation, route `oob`;
- one page row when severity is `page`;
- `escalation_count` incremented once.

## Verify the Page Line

`explain` reports `deterministic_line`:

- `sent`: channel outbound accepted the job;
- `skipped_no_binding`: session has no bound chat;
- `failed`: outbound rejected the job.

If `failed`, inspect the channel outbound receipt and the target chat id. Do not "fix" it by publishing two prompts.

## Budget Exhausted

```bash
ravi signals budget --json
```

Expected: `used`, `limit`, `held`. If a page is still being delivered, that is policy, not a bug; it is audited.

## Duplicate Surface Investigation

Order of checks:

1. same signal, two surface rows in one `cooldown_ms` window;
2. two tick owners;
3. render transform invoked per message instead of per turn;
4. producer changed `key`;
5. OOB sent before the surface row was committed.

Only the last one is a hard defect in the delivery path; the others are configuration or producer defects.

## Disable Escalation Only

If piggyback is useful but pages are noisy:

- set `signals.oob_enabled=false`, or
- set `escalate_after_ms` to null for the noisy keys, or
- mute the key.

Do not disable tick silently; `explain` must show the reason.
