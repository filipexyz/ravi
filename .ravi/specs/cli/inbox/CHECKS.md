# Console Delivery CLI Compatibility / CHECKS

## Agent-First Contract Checks

- `inbox replay <ref> --json` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the `{ref, itemId, sequence, eventTopic, nextReplayCount}`
  plan, and MUST NOT publish to NATS or change `replay_count`; with
  `--execute` the republish MUST happen.
- `inbox replay <unknown-ref> --json` MUST exit 1 with the
  `INBOX_ITEM_NOT_FOUND` envelope and suggestions from the delivery mirror —
  not-found resolves BEFORE the brake, so it is never exit 3.
- `inbox read|done|snooze|archive <unknown-id> --json` MUST exit 1 with
  `INBOX_ITEM_NOT_FOUND` and suggestions from the local inbox listing, even
  though the underlying local-db helpers throw on unknown ids.
- An ambiguous remote item id MUST keep the pre-existing fail-closed error
  (exit 1, no NOT_FOUND code) requiring the local numeric row id.
- `inbox list --fields a,b,c --json` and `inbox items --fields a,b,c --json`
  MUST return items containing only the requested fields.
- Unbraked writes (`done`, `archive`, `snooze`, `enable`, `disable`, `poll`)
  MUST keep immediate-write behavior as declared in the SPEC.
- `bun test src/cli/commands/inbox.test.ts` SHOULD pass after any change to
  the inbox CLI surface.

## Static Checks

- No Console server secrets or proprietary policy are embedded in OSS code.
- Compatibility delivery commands that return bounded snapshots support
  `--json`.
- Local mirror writes happen before NATS publish and Console ack.
- NATS publish includes a server flush before `delivered_at` or Console ack.
- Poll-lease ownership is renewed and verified before every NATS publish and
  Console ack.
- Console ack is not attempted for an item unless local publish succeeded.
- Partial/error Console ack does not update `acked_at`, generation, or sequence
  progress for the batch.
- A later authoritative subscription cursor reconciles only already-delivered,
  still-unacked rows in the same Console+organization scope.
- Delivery progress sorts by sequence and advances only across a contiguous
  successful prefix.
- Intermediate pages advance the batch cursor but retain neither generation nor
  ETag; `hasMore` schedules the next page immediately.
- Ack-only redelivery preserves the exact stored payload/provenance and skips
  enrichment, ingestion, and NATS publish.
- Fresh Ravi state creates the Console delivery mirror and poll-lease schema.
- A paused subscription resumes after valid login/explicit enable.
- A concurrent poll owner is rejected until the renewable SQLite lease is
  released or expires.
- Concurrent ticks on one runner instance are coalesced into one poll cycle.
- Poll-lease release failure does not suppress the next scheduled tick.
- Replay republishes local SQLite payloads and does not call Console item
  creation endpoints.
- Replay uses the live canonical-plus-watch publisher, flushes NATS, and updates
  `replay_count` only after flush success.
- Remote item-id replay fails closed when more than one Console+organization
  scope owns the same id.
- The compatibility delivery CLI does not expose watch creation or watch
  connector management; those belong to `ravi watch`.
- New docs and specs do not describe Console delivery as the product inbox.

## CLI Checks

```bash
ravi inbox status --json
ravi inbox poll --once --json
ravi inbox items --limit 25 --json
```

These are compatibility commands until the target `ravi console delivery ...`
surface exists.

Expected:

- JSON output contains no access token or refresh token.
- `status` includes credentials/scopes/subscriptions/pending counts.
- `poll --once` exits after one tick.
- item listing is bounded.
- Console-produced watch events expose a normalized `ravi.watch...` subject for
  ordinary trigger subscriptions.
- Watch delivery item `eventType` uses `watch.<provider>.<event>`, while the local
  trigger subject uses `ravi.watch.<provider>.<event>`.

## Delivery Regression

Simulate one changed pulse with one item.

Expected order:

1. local item row exists;
2. the poll lease is renewed before each applicable NATS subject;
3. canonical and normalized watch NATS publishes succeed;
4. NATS flush succeeds;
5. local `delivered_at` is set;
6. the poll lease is renewed before Console ack;
7. Console returns `acked === requested`;
8. local `acked_at` and contiguous cursor progress are committed.

Repeat with a partial ack and a delivery sequence gap.

Expected:

- partial/error ack advances neither local ack state nor the cursor;
- an advanced cursor in the next pulse heals `unacked` for locally delivered
  rows only;
- a sequence gap blocks that sequence and all later progress in the batch.

Repeat with two poll pages under one watermark.

Expected:

- page one persists its contiguous cursor without generation or ETag;
- page two is requested without an `If-None-Match` deadlock;
- generation is committed only after the second page reaches the watermark.

## Replay Regression

Replay a stored item.

Expected:

- NATS payload preserves `eventId`, `sequence`, `dedupeKey`, `eventType`, and
  original timestamps;
- replay metadata is additive;
- canonical and normalized watch subjects are both republished when applicable;
- NATS flush completes before `replay_count` increments;
- a flush failure leaves `replay_count` unchanged;
- Console is not called to create a new delivery item.
- an ambiguous remote item id requires a local numeric row id.
