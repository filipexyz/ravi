# Console Provider Watches / RUNBOOK

## Discover Capabilities

```bash
ravi watch connectors --json
ravi watch create github owner/repo --event pull_request.merged --placement auto
```

Internally the CLI should call:

```text
GET /api/cli/watches/capabilities?provider=github&eventTypes=pull_request.merged
```

If Console returns `INSTALLATION_MISSING`, show the returned install/connect URL.

## Create Console Watch

```text
POST /api/cli/watches
```

Body includes provider, `placement:"console"`, installation/resource ids,
event types, filters, and `delivery:{type:"inbox"}`.

Expected response includes watch id, status, and trigger-ready
`ravi.watch.github...` subjects.

Use an `Idempotency-Key` header or `clientRequestId` so retries do not create
duplicate watches.

## Debug Delivery

Check in order:

1. GitHub App installation exists and includes the repo.
2. GitHub webhook delivery is healthy in Console.
3. Console matched at least one active watch.
4. Console created an inbox item.
5. Local `ravi inbox status` shows recent delivery.
6. Local NATS published `ravi.watch.github.<event>`.
7. `ravi triggers show <id>` subscribes to that subject and watch filter.

## Disable

```bash
ravi watch disable <watch-id>
```

Console should disable the watch mapping only. It must not uninstall the GitHub
App or remove provider connection state.
