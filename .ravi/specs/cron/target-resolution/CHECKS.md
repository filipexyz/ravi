# Cron Target Resolution / CHECKS

## JSON List Includes Target Resolution

```bash
ravi cron list --json --limit 1 | jq '.items[0].targetResolution'
```

Expected:

- `state` is one of: `ok`, `agent_missing`, `reply_session_missing`, `derived_key`, `unresolved`;
- field is present on every item.

## JSON List Is Parseable

```bash
ravi cron list --json --limit 500 > /tmp/cron-list.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/cron-list.json','utf8')); console.log('ok')"
```

Expected: prints `ok` with no error.

## Items and Jobs Carry Equivalent Fields

```bash
ravi cron list --json --limit 5 | jq '[.items[0].targetResolution, .jobs[0].targetResolution] | .[0] == .[1]'
```

Expected: `true`.

## Doctor Check Emits Stable Finding IDs

```bash
ravi doctor --json | jq '.checks[] | select(.id == "cron.targets") | .data.findings[].id'
```

Expected: each finding id is one of `cron.agent_missing`, `cron.reply_session_missing`,
`cron.routing_derived_key`, `cron.routing_unresolved`.

## Shell Jobs Without Notification Targets

Given a shell cron with no `onError`:

```bash
ravi cron list --json | jq '.items[] | select(.executionType == "shell" and .onError == null) | .targetResolution.state'
```

Expected: `ok` (not `agent_missing`).
