# Console Delivery CLI Compatibility / CHECKS

## Static Checks

- No Console server secrets or proprietary policy are embedded in OSS code.
- Compatibility delivery commands that return bounded snapshots support
  `--json`.
- Local mirror writes happen before NATS publish and Console ack.
- Console ack is not attempted for an item unless local publish succeeded.
- Replay republishes local SQLite payloads and does not call Console item
  creation endpoints.
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
2. NATS publish succeeds;
3. local `delivered_at` is set;
4. Console ack is sent;
5. local `acked_at` is set after ack success.

## Replay Regression

Replay a stored item.

Expected:

- NATS payload preserves `eventId`, `sequence`, `dedupeKey`, `eventType`, and
  original timestamps;
- replay metadata is additive;
- Console is not called to create a new delivery item.
