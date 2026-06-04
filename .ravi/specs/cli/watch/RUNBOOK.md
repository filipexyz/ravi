# Watch CLI / RUNBOOK

## Discover

```bash
ravi watch connectors
ravi watch connectors --json
```

## Create Npm Watch

```bash
ravi watch create npm zod --event package.version_published
```

## Create GitHub Watch

```bash
ravi watch create github owner/repo --event release.published
```

For webhook-backed GitHub watches this should resolve to Console placement when
the Ravi GitHub App is installed:

```text
GET  /api/cli/watches/capabilities?provider=github&eventTypes=release.published
POST /api/cli/watches
```

## Notify Current Group

From the target group chat:

```bash
ravi watch trigger <watch-id> --message "Resume o evento e diga se precisamos agir."
```

## Inspect

```bash
ravi watch list
ravi watch show <watch-id>
ravi watch events <watch-id>
```

## Stop

```bash
ravi watch disable <watch-id>
ravi triggers disable <trigger-id>
```
