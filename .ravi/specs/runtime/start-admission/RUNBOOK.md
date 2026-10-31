# Capacity refusal

Inspect `dispatch.start_rejected` / `dispatch.start_timeout` and their lane, occupants, reservations, largest consumer and queue position. `active` means resident runtimes, not necessarily executing turns; occupant `state` distinguishes them.

A user receives an `inbox_item_*` receipt. `ravi inbox read <receipt> --json` exposes the original prompt in `item.metadata.prompt`, session identity, and capacity snapshot. Free capacity, review the saved envelope and its authority, then resume it through the normal prompt publisher as a new delivery. Do not ask the user to repeat the message. Do not replay a source message by mutating its original receipt.

The 2026-10-31 incident logged four console-infra background starts at 11:58–11:59 with active=8, reserved=0, global max=12, background limit=8. Slots became available only at idle evictions (12:00:23 and 12:03:59); one waiter expired at 12:03:50, five minutes after admission. Another expired at 12:25:05 and an idle eviction followed ten seconds later. Existing telemetry did not enumerate occupants at timeout, so it cannot identify every slot holder retrospectively. Code reclaimed only observers during admission; ordinary idle runtimes held their slots until TTL. Prompt dispatch already used per-session tails, not a global start mutex. Presence receipt was emitted only after dispatch; native presence delivery additionally awaited every API call in a shared loop.

This fix changes source only. Applying it requires the normal reviewed deployment; no running stream, provider, route, production DB or daemon is changed by the PR.
