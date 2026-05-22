# Watch / RUNBOOK

## List Connectors

```bash
ravi watch connectors
ravi watch connectors --json
```

Check local and Console placement support before creating a watch.

## Create A Watch

Examples:

```bash
ravi watch create npm @scope/pkg --event package.version_published
ravi watch create github owner/repo --event release.published
```

The command should print:

- watch id;
- connector;
- placement;
- event subjects;
- next trigger command.

## Attach A Trigger

From a group chat, prefer the watch helper when available:

```bash
ravi watch trigger <watch-id> --event release.published --message "Resume a release e diga se precisamos agir."
```

Equivalent low-level form:

```bash
ravi triggers add "GitHub release" \
  --topic "ravi.watch.github.release.published" \
  --filter "data.watchId == '<watch-id>'" \
  --message "Resume a release e diga se precisamos agir."
```

## Debug Events

Subscribe broadly while debugging:

```text
ravi.watch.>
```

For Console-produced watches, also inspect inbox delivery:

```bash
ravi inbox status
ravi inbox items --limit 25
```

## Disable

```bash
ravi watch disable <watch-id>
ravi triggers disable <trigger-id>
```

Disabling a watch stops event production. Disabling a trigger only stops the
chat reaction; the watch may continue producing events for other consumers.
