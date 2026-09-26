# Page comment wake via triggers / RUNBOOK

## Confirm the binding

```bash
ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json --execute
ravi triggers list --json
```

Expect `commentFollow.ok: true`, `topic: ravi.watch.console.page.comment.created`, and one trigger named `page-comment:<site id>`. A second ship of the same slug returns `reused: true` and the same `triggerId`.

`commentFollow.skipped`:

- `missing_creator` — the ship had no agent id. Re-run inside an agent session.
- `missing_page` — Console did not return a site id. Do not invent one from the slug.
- `invalid_filter` — the generator refused to save. The trigger row should be absent.
- `unbound_agent` — the row exists but the agent is gone. `ravi triggers show <id>` reports `unbound_agent`. Recreate the agent, then `ravi triggers` refresh (any trigger mutation emits `ravi.triggers.refresh`) before expecting a wake.

## Confirm ingest

Console must deliver Agent Inbox `eventType: page.comment.created` (not a sync-ledger row). After the inbox runner publishes, a trigger subscription on `ravi.watch.console.page.comment.created` should see `payload.pageId` equal to the site id bound at ship.

`page.comment.resolved` is published on `ravi.watch.console.page.comment.resolved` and is catalog-only in v0. No ship trigger listens to it.

## Wake did not happen

1. `ravi triggers show <id>` — `runtimeState` must be `active`. `invalid_filter` and `unbound_agent` do not subscribe.
2. Confirm the event's page id, org id, and project id match the filter. A project slug in the filter is a bug; only ids belong there.
3. The creator's own comment still wakes in v0. Silence means the filter or the agent binding missed, not an author suppression.
4. Anchors are ignored. A comment that differs only by anchor still uses the page id filter.
