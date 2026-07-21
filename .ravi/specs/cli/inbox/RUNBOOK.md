# Console Delivery CLI Compatibility / RUNBOOK

## Status

```bash
ravi inbox status
ravi inbox status --json
```

These are compatibility commands. The target technical command family should be
`ravi console delivery ...` once the real `ravi inbox` product CLI lands.

Check:

- credentials are present;
- Console URL and organization are correct;
- required scopes are present;
- subscription is enabled and active;
- cursor/generation are moving after deliveries;
- pending unacked count is not growing unexpectedly.

## Enable Or Disable Local Polling

```bash
ravi inbox enable
ravi inbox disable
```

Use `disable` when debugging server behavior without local leases.
Running `enable` on an already-enabled paused/errored subscription revalidates
it, clears stale errors, and returns it to `active`; repeating `enable` after
that is a no-op.

## One Foreground Tick

```bash
ravi inbox poll --once --json
```

Expected:

- missing credentials or scopes produce a safe error/paused status;
- no-change path completes without polling;
- changed path persists items, publishes canonical and normalized watch NATS
  events, flushes, marks delivered, then acks Console;
- a partial/error ack leaves local ack and cursor progress unchanged;
- a later pulse whose Console cursor has advanced heals local `unacked` rows
  that were already delivered in that Console+organization scope;
- multi-page polls retain neither generation nor ETag between pages;
- cursor progress stops at the first failed or non-contiguous sequence.

## Replay Local Event

```bash
ravi inbox items --limit 25
ravi inbox replay <item-id-or-local-row-id>
```

Replay should publish to `ravi.console.inbox.item` from the SQLite mirror. It
must not create a new Console delivery item. Success means all applicable NATS
subjects were flushed; `replay_count` remains unchanged when publish or flush
fails.

If the same remote item id exists in multiple Console+organization scopes, use
the local numeric row id; remote-id replay fails closed rather than guessing.

If the item contains a watch event, the bridge should also expose the normalized
watch topic from `ravi watch show <watch-id>` or the event payload.

## Poll Lease Debug

The poll lease is stored in `console_inbox_poll_locks`, keyed by normalized
Console URL and organization. A second runner must wait until the current owner
releases the lease or its bounded TTL expires. The active owner renews before
each NATS publish and Console ack; losing ownership aborts the batch without
advancing local ack/cursor state. A lease-release error is logged, but the daemon
still schedules its next tick.

## NATS Debug

Subscribe to:

```text
ravi.console.inbox.item
```

Verify stable identity fields: `eventId`, `sequence`, `dedupeKey`,
`eventType`, `occurredAt`, and `createdAt`.

For trigger debugging, prefer normalized watch subjects:

```text
ravi.watch.>
ravi.watch.github.>
ravi.watch.npm.>
```
