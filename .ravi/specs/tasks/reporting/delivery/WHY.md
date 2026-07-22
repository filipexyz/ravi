# Task Reporting Delivery Rationale

## Why Delivery Is A Separate, Explicit Path

Durable task state belongs to the task runtime. Reaching a person or a
coordinating session with a report is a secondary effect, not the source of
truth. Keeping delivery explicit — gated on a configured report target and a
matching report-event filter — prevents chat prose from being mistaken for
durable progress and prevents unconfigured tasks from spamming other sessions.

## Why Cross-Store Idempotency Matters Here

Once tasks are work-owned and sessions are core-owned, publishing a report
prompt crosses a store boundary. Without a stable idempotency key, a retry or a
replayed task event delivers the same report twice; without a durable receipt,
a crash between publish and "delivered" loses the report or duplicates it on
recovery.

Deriving the key from the durable task event, the target session, and the
renderer/protocol version makes replays safe, while a payload hash catches the
dangerous case where the same logical report would render different content —
which must fail closed rather than deliver a divergent prompt. This mirrors the
`tasks/dispatch` intent/receipt discipline instead of inventing a second one.

## Why Reference The Shared Outbox

Dispatch, report delivery, and thread handoff all need the same durable
cross-store delivery primitive. Building a report-specific outbox here would
duplicate the storage topology's shared outbox/receipt protocol and force a
later reconciliation. This feature names the states and evidence it needs and
defers the mechanism to that shared contract.

## Why Observers Stay Isolated

Observer-driven status sync lets a worker avoid a default task-sync protocol.
That convenience must not leak worker tool or channel authority into the
observer. Observer mutations must be authorized by the observer runtime context
and grounded in source events so duplicate deliveries can be deduped.
