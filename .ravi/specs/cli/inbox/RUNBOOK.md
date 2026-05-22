# Console Inbox CLI / RUNBOOK

## Status

```bash
ravi inbox status
ravi inbox status --json
```

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

## One Foreground Tick

```bash
ravi inbox poll --once --json
```

Expected:

- missing credentials or scopes produce a safe error/paused status;
- no-change path completes without polling;
- changed path persists items, publishes NATS, then acks Console.

## Replay Local Event

```bash
ravi inbox items --limit 25
ravi inbox replay <item-id-or-local-row-id>
```

Replay should publish to `ravi.console.inbox.item` from the SQLite mirror. It
must not create a new Console inbox item.

If the item contains a watch event, the bridge should also expose the normalized
watch topic from `ravi watch show <watch-id>` or the event payload.

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
